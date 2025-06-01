import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

class InstallationManager {
  constructor(app) {
    this.app = app;
    this.installations = new Map();
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    this.installationsFile = path.join(__dirname, '../../data/installations.json');
    this.loadInstallations(); // Load on startup
  }

  async loadInstallations() {
    try {
      // Ensure data directory exists
      await fs.mkdir(path.dirname(this.installationsFile), { recursive: true });
      
      // Try to load existing installations
      const data = await fs.readFile(this.installationsFile, 'utf8');
      const installations = JSON.parse(data);
      
      // Convert array back to Map
      for (const installation of installations) {
        this.installations.set(installation.id, installation);
      }
      
      console.log(`Loaded ${installations.length} installations from disk`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Error loading installations:', error.message);
      } else {
        console.log('No existing installations file found, starting fresh');
      }
    }
  }

  async saveInstallations() {
    try {
      const installations = Array.from(this.installations.values());
      await fs.writeFile(this.installationsFile, JSON.stringify(installations, null, 2));
      console.log(`Saved ${installations.length} installations to disk`);
    } catch (error) {
      console.error('Error saving installations:', error.message);
    }
  }

  async handleInstallation(installation) {
    const installationData = {
      id: installation.id,
      account: installation.account.login,
      repositories: [],
      lastNibble: null,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // If installation has repositories list, add them
    if (installation.repositories) {
      installationData.repositories = installation.repositories.map(repo => ({
        id: repo.id,
        full_name: repo.full_name,
        default_branch: repo.default_branch,
        language: repo.language
      }));
    }

    this.installations.set(installation.id, installationData);
    await this.saveInstallations(); // Persist to disk
    console.log(`Stored installation ${installation.id} for ${installation.account.login} with ${installationData.repositories.length} repositories`);
  }

  async addRepositoryToInstallation(repository, installation) {
    const installationData = this.installations.get(installation.id);
    if (!installationData) {
      console.log(`Installation ${installation.id} not found, creating new entry`);
      await this.handleInstallation(installation);
      return;
    }
    
    installationData.repositories = installationData.repositories || [];
    
    const repoExists = installationData.repositories.find(r => r.full_name === repository.full_name);
    if (!repoExists) {
      installationData.repositories.push({
        id: repository.id,
        full_name: repository.full_name,
        default_branch: repository.default_branch,
        language: repository.language
      });
      
      installationData.updatedAt = new Date().toISOString();
      this.installations.set(installation.id, installationData);
      await this.saveInstallations(); // Persist changes
    }
    
    console.log(`Added ${repository.full_name} to installation ${installation.id}`);
  }

  async refreshInstallationsFromGitHub() {
    try {
      console.log('Refreshing installations…');
  
      // 1. App-level Octokit (JWT) – no extra imports.
      const appOctokit = await this.app.auth();   // ← already authenticated
  
      // 2. Pull *all* installations (100 per page).
      const installations = await appOctokit.paginate(
        appOctokit.apps.listInstallations,
        { per_page: 100 }
      );
  
      for (const inst of installations) {
        // 3. Installation-scoped Octokit (access token).
        const instOctokit = await this.app.auth(inst.id);
  
        // 4. Fetch every repo the app can reach.
        const repos = await instOctokit.paginate(
          instOctokit.apps.listReposAccessibleToInstallation,
          { per_page: 100 }
        );
  
        this.installations.set(inst.id, {
          id:         inst.id,
          account:    inst.account?.login ?? inst.account?.slug,
          repositories: repos.map(r => ({
            id: r.id,
            full_name: r.full_name,
            default_branch: r.default_branch,
            language: r.language
          })),
          lastNibble: null,
          enabled:    true,
          createdAt:  inst.created_at,
          updatedAt:  new Date().toISOString()
        });
      }
  
      await this.saveInstallations();
      console.log(`Refreshed ${this.installations.size} installations`);
      return this.installations.size;
  
    } catch (err) {
      console.error('refreshInstallationsFromGitHub failed:', err);
      throw err;
    }
  }
    
  getInstallations() {
    return Array.from(this.installations.entries()).map(([id, data]) => ({ id, ...data }));
  }

  findInstallationForRepository(owner, repo) {
    return Array.from(this.installations.values())
      .find(inst => inst.repositories?.some(r => r.full_name === `${owner}/${repo}`));
  }

  getAllEnabledInstallations() {
    return Array.from(this.installations.entries())
      .filter(([id, data]) => data.enabled)
      .map(([id, data]) => ({ id, ...data }));
  }
}

export default InstallationManager;

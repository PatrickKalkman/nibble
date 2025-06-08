import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';

const logger = pino();

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
      
      logger.info(`Loaded ${installations.length} installations from disk`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Error loading installations:', error.message);
      } else {
        logger.info('No existing installations file found, starting fresh');
      }
    }
  }

  async saveInstallations() {
    try {
      const installations = Array.from(this.installations.values());
      await fs.writeFile(this.installationsFile, JSON.stringify(installations, null, 2));
      logger.info(`Saved ${installations.length} installations to disk`);
    } catch (error) {
      logger.error('Error saving installations:', error.message);
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
    logger.info(`Stored installation ${installation.id} for ${installation.account.login} with ${installationData.repositories.length} repositories`);
  }

  async addRepositoryToInstallation(repository, installation) {
    const installationData = this.installations.get(installation.id);
    if (!installationData) {
      logger.info(`Installation ${installation.id} not found, creating new entry`);
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
    
    logger.info(`Added ${repository.full_name} to installation ${installation.id}`);
  }

  async cleanupDuplicateInstallations() {
    try {
      logger.info('Cleaning up duplicate installations...');
      
      // Group installations by repository
      const repoToInstallations = new Map();
      
      for (const [id, installation] of this.installations) {
        for (const repo of installation.repositories || []) {
          const key = repo.full_name;
          if (!repoToInstallations.has(key)) {
            repoToInstallations.set(key, []);
          }
          repoToInstallations.get(key).push({ id, installation, repo });
        }
      }
      
      // Find and remove duplicates (keep the newest)
      for (const [repoName, installations] of repoToInstallations) {
        if (installations.length > 1) {
          logger.info(`Found ${installations.length} installations for ${repoName}`);
          
          // Sort by creation date (newest first)
          installations.sort((a, b) => 
            new Date(b.installation.createdAt) - new Date(a.installation.createdAt)
          );
          
          // Keep the newest, remove the rest
          const newest = installations[0];
          logger.info(`Keeping installation ${newest.id} for ${repoName} (created ${newest.installation.createdAt})`);
          
          for (let i = 1; i < installations.length; i++) {
            const old = installations[i];
            logger.info(`Removing old installation ${old.id} for ${repoName} (created ${old.installation.createdAt})`);
            this.installations.delete(old.id);
          }
        }
      }
      
      await this.saveInstallations();
      logger.info('Cleanup complete');
      
    } catch (error) {
      logger.error('Error cleaning up installations:', error);
      throw error;
    }
  }

  async refreshInstallationsFromGitHub() {
    try {
      logger.info('Refreshing installations…');
  
      // 1. App-level Octokit (JWT) – no extra imports.
      const appOctokit = await this.app.auth();   // ← already authenticated
  
      // 2. Pull *all* installations (100 per page).
      const installations = await appOctokit.paginate(
        appOctokit.apps.listInstallations,
        { per_page: 100 }
      );
  
      // Clear existing installations to ensure we only have current ones
      this.installations.clear();
  
      for (const inst of installations) {
        try {
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
        } catch (error) {
          // Skip installations that throw errors (e.g., 404s)
          logger.warn(`Skipping installation ${inst.id} due to error: ${error.message}`);
        }
      }
  
      await this.saveInstallations();
      logger.info(`Refreshed ${this.installations.size} installations`);
      return this.installations.size;
  
    } catch (err) {
      logger.error('refreshInstallationsFromGitHub failed:', err);
      throw err;
    }
  }

  async validateAndCleanInstallations() {
    logger.info('Validating installations against GitHub...');
    
    const invalidInstallations = [];
    
    for (const [id, installation] of this.installations) {
      try {
        const octokit = await this.app.auth(id);
        // Try to get the installation - this will fail if it's invalid
        await octokit.apps.getInstallation({ installation_id: id });
        logger.info(`Installation ${id} is valid`);
      } catch (error) {
        if (error.status === 404) {
          logger.warn(`Installation ${id} is no longer valid on GitHub`);
          invalidInstallations.push(id);
        }
      }
    }
    
    // Remove invalid installations
    for (const id of invalidInstallations) {
      this.installations.delete(id);
    }
    
    if (invalidInstallations.length > 0) {
      await this.saveInstallations();
      logger.info(`Removed ${invalidInstallations.length} invalid installations`);
    }
    
    return invalidInstallations.length;
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

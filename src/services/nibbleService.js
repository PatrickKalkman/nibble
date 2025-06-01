import InstallationManager from './installationManager.js';

class NibbleService {
  constructor(app) {
    this.app = app;
    this.installationManager = new InstallationManager(app);
  }

  async handleInstallation(installation) {
    return await this.installationManager.handleInstallation(installation);
  }

  async scheduleDailyNibble(repository, installation) {
    await this.installationManager.addRepositoryToInstallation(repository, installation);
    console.log(`Scheduled ${repository.full_name} for daily nibbles`);
  }

  async refreshInstallationsFromGitHub() {
    return await this.installationManager.refreshInstallationsFromGitHub();
  }
    
  getInstallations() {
    return this.installationManager.getInstallations();
  }

  async runNightlyNibbles() {
    console.log('Starting nightly nibble run...');
    
    const enabledInstallations = this.installationManager.getAllEnabledInstallations();
    
    for (const installation of enabledInstallations) {
      try {
        const octokit = await this.app.getInstallationOctokit(installation.id);
        
        for (const repo of installation.repositories || []) {
          try {
            await this.performNibble(repo.full_name.split('/')[0], repo.full_name.split('/')[1], octokit);
            await this.sleep(5000); // Rate limiting - wait 5s between repos
          } catch (error) {
            console.error(`Error nibbling ${repo.full_name}:`, error.message);
          }
        }
      } catch (error) {
        console.error(`Error processing installation ${installation.id}:`, error.message);
      }
    }
  }

  async performNibble(owner, repo, octokit = null) {
    if (!octokit) {
      // Find the installation for this repo
      const installation = this.installationManager.findInstallationForRepository(owner, repo);
      
      if (!installation) {
        throw new Error(`No installation found for ${owner}/${repo}. Make sure the app is installed on this repository.`);
      }
      
      console.log(`Using installation ${installation.id} for ${owner}/${repo}`);
      octokit = await this.app.getInstallationOctokit(installation.id);
    }

    console.log(`Performing nibble on ${owner}/${repo}`);

    // Check if there's already an open Nibble PR
    const existingPRs = await octokit.pulls.list({
      owner,
      repo,
      state: 'open',
      head: `${owner}:nibble/daily-improvement`
    });

    if (existingPRs.data.length > 0) {
      console.log(`Skipping ${owner}/${repo} - existing Nibble PR found`);
      return { skipped: true, reason: 'existing_pr' };
    }

    // Get repository info
    const repoInfo = await octokit.repos.get({ owner, repo });
    const defaultBranch = repoInfo.data.default_branch;

    // Create a new branch
    const branchName = `nibble/daily-improvement-${new Date().toISOString().split('T')[0]}`;
    
    // Get the latest commit SHA from default branch
    const { data: refData } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`
    });

    // Create new branch
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: refData.object.sha
    });

    // For now, let's create a simple improvement (we'll replace this with AI later)
    const improvement = await this.findSimpleImprovement(octokit, owner, repo, defaultBranch);
    
    if (!improvement) {
      // Delete the branch if no improvement found
      await octokit.git.deleteRef({
        owner,
        repo,
        ref: `heads/${branchName}`
      });
      return { skipped: true, reason: 'no_improvement_found' };
    }

    // Apply the improvement
    await this.applyImprovement(octokit, owner, repo, branchName, improvement);

    // Create pull request
    const pr = await octokit.pulls.create({
      owner,
      repo,
      title: `🍽️ Daily Nibble: ${improvement.title}`,
      body: this.generatePRBody(improvement),
      head: branchName,
      base: defaultBranch
    });

    console.log(`Created nibble PR #${pr.data.number} for ${owner}/${repo}`);
    
    return {
      success: true,
      pr: pr.data.html_url,
      improvement: improvement.title
    };
  }

  async findSimpleImprovement(octokit, owner, repo, branch) {
    // For now, let's implement a simple NIBBLE finder
    // Later we'll replace this with AI analysis
    
    try {
      // Search for NIBBLE comments
      const searchResult = await octokit.search.code({
        q: `NIBBLE repo:${owner}/${repo}`,
        per_page: 10
      });

      if (searchResult.data.items.length > 0) {
        const nibbleItem = searchResult.data.items[0];
        
        return {
          type: 'nibble_comment',
          title: 'Address NIBBLE comment',
          file: nibbleItem.path,
          description: `Found NIBBLE comment in ${nibbleItem.path}`,
          action: 'add_comment',
          details: 'Added implementation note for NIBBLE item'
        };
      }

      // Look for README improvements
      try {
        const readmeResult = await octokit.repos.getContent({
          owner,
          repo,
          path: 'README.md'
        });

        const readmeContent = Buffer.from(readmeResult.data.content, 'base64').toString();
        
        if (!readmeContent.includes('## Installation')) {
          return {
            type: 'readme_improvement',
            title: 'Add Installation section to README',
            file: 'README.md',
            description: 'README missing installation instructions',
            action: 'add_section',
            details: 'Added basic installation section to README'
          };
        }
      } catch (error) {
        // README doesn't exist or not accessible
      }

      return null;
    } catch (error) {
      console.error('Error finding improvement:', error.message);
      return null;
    }
  }

  async applyImprovement(octokit, owner, repo, branch, improvement) {
    if (improvement.type === 'nibble_comment') {
      // Get the file content
      const fileResult = await octokit.repos.getContent({
        owner,
        repo,
        path: improvement.file,
        ref: branch
      });

      let content = Buffer.from(fileResult.data.content, 'base64').toString();
      
      // Simple improvement: add a comment after NIBBLE
      content = content.replace(
        /\/\/\s*NIBBLE:/g, 
        '// NIBBLE: (Nibble note: Consider implementing this soon)\n// NIBBLE:'
      );

      // Update the file
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: improvement.file,
        message: `🍽️ Nibble: ${improvement.title}`,
        content: Buffer.from(content).toString('base64'),
        branch,
        sha: fileResult.data.sha
      });
    } else if (improvement.type === 'readme_improvement') {
      // Get README content
      const readmeResult = await octokit.repos.getContent({
        owner,
        repo,
        path: 'README.md',
        ref: branch
      });

      let content = Buffer.from(readmeResult.data.content, 'base64').toString();
      
      // Add installation section
      const installationSection = `

## Installation

\`\`\`bash
# Clone the repository
git clone https://github.com/${owner}/${repo}.git
cd ${repo}

# Install dependencies
npm install

# Run the project
npm start
\`\`\`
`;

      content += installationSection;

      // Update README
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: 'README.md',
        message: `🍽️ Nibble: ${improvement.title}`,
        content: Buffer.from(content).toString('base64'),
        branch,
        sha: readmeResult.data.sha
      });
    }
  }

  generatePRBody(improvement) {
    return `## 🍽️ Daily Nibble

**Small improvement made:** ${improvement.title}

### What changed?
${improvement.description}

### Why this matters
Every small improvement compounds over time. This nibble addresses a minor issue that makes the codebase slightly better for future developers.

### Review notes
- This is an automated improvement from Nibble
- The change is intentionally small and focused
- Review should take less than 2 minutes
- Safe to merge if the change looks reasonable

---
*This PR was created by Nibble - making your code slightly better, one bite at a time* 🤖`;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default NibbleService;

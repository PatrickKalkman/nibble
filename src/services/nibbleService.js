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

    // Find and apply improvement
    const improvement = await this.findNibbleComments(octokit, owner, repo, defaultBranch);
    
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

  async findNibbleComments(octokit, owner, repo, branch) {
    try {
      // Search for NIBBLE comments in the repository
      const searchResult = await octokit.search.code({
        q: `NIBBLE repo:${owner}/${repo}`,
        per_page: 5
      });

      if (searchResult.data.items.length > 0) {
        // Take the first found NIBBLE comment
        const nibbleItem = searchResult.data.items[0];
        
        // Get the full file content to analyze the NIBBLE comment
        const fileContent = await octokit.repos.getContent({
          owner,
          repo,
          path: nibbleItem.path,
          ref: branch
        });

        const content = Buffer.from(fileContent.data.content, 'base64').toString();
        const lines = content.split('\n');
        
        // Find lines with NIBBLE comments
        const nibbleLines = [];
        lines.forEach((line, index) => {
          if (line.includes('NIBBLE') && (line.trim().startsWith('#') || line.trim().startsWith('//'))) {
            nibbleLines.push({
              lineNumber: index + 1,
              content: line,
              commentType: line.trim().startsWith('#') ? '#' : '//'
            });
          }
        });

        if (nibbleLines.length > 0) {
          const nibbleLine = nibbleLines[0]; // Use the first found NIBBLE
          
          return {
            type: 'nibble_comment',
            title: 'Add tracking to NIBBLE comment',
            file: nibbleItem.path,
            description: `Found NIBBLE comment at line ${nibbleLine.lineNumber} in ${nibbleItem.path}`,
            nibbleLine: nibbleLine,
            fileSha: fileContent.data.sha
          };
        }
      }

      return null;
    } catch (error) {
      console.error('Error finding NIBBLE comments:', error.message);
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
      const lines = content.split('\n');
      
      // Find the NIBBLE comment and add our tracking comment
      const currentDateTime = new Date().toISOString();
      const commentPrefix = improvement.nibbleLine.commentType;
      const trackingComment = `${commentPrefix} NIBBLE found it ${currentDateTime}`;
      
      // Find the line with the NIBBLE comment and add our tracking line after it
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('NIBBLE') && 
            (lines[i].trim().startsWith('#') || lines[i].trim().startsWith('//'))) {
          // Insert our tracking comment right after the NIBBLE line
          lines.splice(i + 1, 0, trackingComment);
          break;
        }
      }

      // Reconstruct the file content
      const newContent = lines.join('\n');

      // Update the file
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: improvement.file,
        message: `🍽️ Nibble: ${improvement.title}`,
        content: Buffer.from(newContent).toString('base64'),
        branch,
        sha: fileResult.data.sha
      });

      console.log(`Successfully added tracking comment to ${improvement.file}`);
    }
  }

  generatePRBody(improvement) {
    return `## 🍽️ Daily Nibble

**Small improvement made:** ${improvement.title}

### What changed?
${improvement.description}

Added a tracking comment to show that Nibble has found and processed this NIBBLE comment.

### Why this matters
This demonstrates that Nibble can successfully:
- Find NIBBLE comments in your codebase
- Make actual changes to source files
- Create meaningful pull requests with real modifications

### Review notes
- This is an automated improvement from Nibble
- The change adds a timestamped comment to track NIBBLE processing
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
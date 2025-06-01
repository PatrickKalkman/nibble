import InstallationManager from './installationManager.js';
import NibbleAI from './nibbleAI.js';
import pino from 'pino';

class NibbleService {
  constructor(app) {
    this.app = app;
    this.installationManager = new InstallationManager(app);
    this.ai = new NibbleAI(process.env.OPENAI_API_KEY);
    this.logger = pino();
  }

  async handleInstallation(installation) {
    return await this.installationManager.handleInstallation(installation);
  }

  async scheduleDailyNibble(repository, installation) {
    await this.installationManager.addRepositoryToInstallation(repository, installation);
    this.logger.info(`Scheduled ${repository.full_name} for daily nibbles`);
  }

  async refreshInstallationsFromGitHub() {
    return await this.installationManager.refreshInstallationsFromGitHub();
  }
    
  getInstallations() {
    return this.installationManager.getInstallations();
  }

  async runNightlyNibbles() {
    this.logger.info('Starting nightly nibble run...');
    
    const enabledInstallations = this.installationManager.getAllEnabledInstallations();
    
    for (const installation of enabledInstallations) {
      try {
        const octokit = await this.app.getInstallationOctokit(installation.id);
        
        for (const repo of installation.repositories || []) {
          try {
            await this.performNibble(repo.full_name.split('/')[0], repo.full_name.split('/')[1], octokit);
            await this.sleep(5000); // Rate limiting - wait 5s between repos
          } catch (error) {
            this.logger.error(`Error nibbling ${repo.full_name}:`, error.message);
          }
        }
      } catch (error) {
        this.logger.error(`Error processing installation ${installation.id}:`, error.message);
      }
    }
  }

  async performNibble(owner, repo, octokit = null) {
    if (!octokit) {
      const installation = this.installationManager.findInstallationForRepository(owner, repo);
      
      if (!installation) {
        throw new Error(`No installation found for ${owner}/${repo}. Make sure the app is installed on this repository.`);
      }
      
      this.logger.info(`Using installation ${installation.id} for ${owner}/${repo}`);
      octokit = await this.app.getInstallationOctokit(installation.id);
    }

    this.logger.info(`Performing nibble on ${owner}/${repo}`);

    // Check if there's already an open Nibble PR
    const existingPRs = await octokit.pulls.list({
      owner,
      repo,
      state: 'open',
      head: `${owner}:nibble/daily-improvement`
    });

    if (existingPRs.data.length > 0) {
      this.logger.info(`Skipping ${owner}/${repo} - existing Nibble PR found`);
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

    // Find and analyze NIBBLE comments with AI
    const improvement = await this.findAndAnalyzeNibble(octokit, owner, repo, defaultBranch);
    
    if (!improvement) {
      // Delete the branch if no improvement found
      await octokit.git.deleteRef({
        owner,
        repo,
        ref: `heads/${branchName}`
      });
      return { skipped: true, reason: 'no_improvement_found' };
    }

    // Apply the AI-suggested improvement
    await this.applyAIImprovement(octokit, owner, repo, branchName, improvement);

    // Create pull request
    const pr = await octokit.pulls.create({
      owner,
      repo,
      title: `🍽️ Daily Nibble: ${improvement.title}`,
      body: this.generateAIPRBody(improvement),
      head: branchName,
      base: defaultBranch
    });

    this.logger.info(`Created AI nibble PR #${pr.data.number} for ${owner}/${repo}`);
    
    return {
      success: true,
      pr: pr.data.html_url,
      improvement: improvement.title,
      confidence: improvement.confidence
    };
  }

  async findAndAnalyzeNibble(octokit, owner, repo, branch) {
    try {
      // Search for NIBBLE comments in the repository
      const searchResult = await octokit.search.code({
        q: `NIBBLE repo:${owner}/${repo}`,
        per_page: 5
      });

      if (searchResult.data.items.length === 0) {
        this.logger.info(`No NIBBLE comments found in ${owner}/${repo}`);
        return null;
      }

      // Process each found NIBBLE file until we get a good improvement
      for (const nibbleItem of searchResult.data.items) {
        try {
          const improvement = await this.analyzeNibbleInFile(octokit, owner, repo, branch, nibbleItem);
          if (improvement && improvement.confidence > 0.7) {
            return improvement;
          }
        } catch (error) {
          this.logger.error(`Error analyzing NIBBLE in ${nibbleItem.path}:`, error.message);
          continue;
        }
      }

      return null;
    } catch (error) {
      this.logger.error('Error finding NIBBLE comments:', error.message);
      return null;
    }
  }

  async analyzeNibbleInFile(octokit, owner, repo, branch, nibbleItem) {
    // Get the full file content
    const fileContent = await octokit.repos.getContent({
      owner,
      repo,
      path: nibbleItem.path,
      ref: branch
    });

    const content = Buffer.from(fileContent.data.content, 'base64').toString();
    const lines = content.split('\n');
    
    // Find the first NIBBLE comment line
    const nibbleLineIndex = lines.findIndex(line => 
      line.includes('NIBBLE') && (line.trim().startsWith('#') || line.trim().startsWith('//'))
    );

    if (nibbleLineIndex === -1) {
      return null;
    }

    // Extract context around the NIBBLE
    const context = this.ai.extractContext(content, nibbleLineIndex);
    const language = this.ai.detectLanguage(nibbleItem.path);

    // Analyze with AI
    const improvement = await this.ai.analyzeNibble({
      file: nibbleItem.path,
      nibbleComment: context.nibbleComment,
      surroundingCode: context.surroundingCode,
      language: language
    });

    if (!improvement) {
      return null;
    }

    // Validate that the search text exists in the file
    if (!this.ai.validateSearchText(content, improvement.searchText)) {
      this.logger.info(`Search text validation failed for ${nibbleItem.path}`);
      return null;
    }

    // Add file metadata
    return {
      ...improvement,
      fileSha: fileContent.data.sha,
      fullContent: content
    };
  }

  async applyAIImprovement(octokit, owner, repo, branch, improvement) {
    this.logger.info(`Applying AI improvement: ${improvement.title}`);
    
    // Apply the search and replace
    let newContent = improvement.fullContent.replace(
      improvement.searchText,
      improvement.replaceText
    );

    // Remove the original NIBBLE comment since it's now addressed
    newContent = this.removeNibbleComment(newContent, improvement.originalNibble);

    // Update the file
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: improvement.file,
      message: `🍽️ Nibble: ${improvement.title}`,
      content: Buffer.from(newContent).toString('base64'),
      branch,
      sha: improvement.fileSha
    });

    this.logger.info(`Successfully applied AI improvement and removed NIBBLE comment from ${improvement.file}`);
  }

  removeNibbleComment(content, nibbleComment) {
    const lines = content.split('\n');
    
    // Find and remove the NIBBLE comment line
    const filteredLines = lines.filter(line => {
      // Remove the exact NIBBLE comment line
      const trimmedLine = line.trim();
      const trimmedNibble = nibbleComment.trim();
      
      // Check if this line matches the NIBBLE comment
      if (trimmedLine === trimmedNibble) {
        return false; // Remove this line
      }
      
      // Also remove if it's just whitespace that was left behind
      if (trimmedLine === '' && lines.indexOf(line) > 0) {
        const prevLine = lines[lines.indexOf(line) - 1];
        const nextLine = lines[lines.indexOf(line) + 1];
        
        // If surrounded by code (not comments), keep the empty line for readability
        if (prevLine && nextLine && 
            !prevLine.trim().startsWith('#') && !prevLine.trim().startsWith('//') &&
            !nextLine.trim().startsWith('#') && !nextLine.trim().startsWith('//')) {
          return true;
        }
      }
      
      return true; // Keep all other lines
    });
    
    return filteredLines.join('\n');
  }

  generateAIPRBody(improvement) {
    return `## 🍽️ Daily Nibble

**AI-suggested improvement:** ${improvement.title}

### What changed?
${improvement.explanation}

**Original NIBBLE comment:** \`${improvement.originalNibble}\` *(now removed)*

### Why this matters
${improvement.explanation}

This small improvement was suggested by AI analysis and addresses the specific concern mentioned in the NIBBLE comment. The original NIBBLE comment has been removed since the issue is now resolved.

### Review notes
- This change was generated by AI analysis of the NIBBLE comment
- **Confidence level:** ${Math.round(improvement.confidence * 100)}%
- The original NIBBLE comment was removed as it's now addressed
- The change is focused and preserves existing functionality
- Review should take less than 5 minutes
- Safe to merge if the improvement looks reasonable

### Technical details
- **File modified:** \`${improvement.file}\`
- **Language:** ${improvement.language}

---
*This PR was created by Nibble AI - making your code slightly better with artificial intelligence, one bite at a time* 🤖✨`;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default NibbleService;

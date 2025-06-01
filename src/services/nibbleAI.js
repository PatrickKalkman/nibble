// services/nibbleAI.js
import OpenAI from 'openai';

class NibbleAI {
  constructor(apiKey) {
    this.openai = new OpenAI({ apiKey });
  }

  /**
   * Analyzes a NIBBLE comment and generates an improvement
   * @param {Object} nibbleContext - Context about the NIBBLE
   * @param {string} nibbleContext.file - File path
   * @param {string} nibbleContext.nibbleComment - The NIBBLE comment text
   * @param {string} nibbleContext.surroundingCode - Code around the NIBBLE
   * @param {string} nibbleContext.language - Programming language
   * @returns {Promise<Object|null>} Improvement suggestion or null
   */
  async analyzeNibble(nibbleContext) {
    try {
      const prompt = this.buildPrompt(nibbleContext);
      
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini', // Cheaper model for simple improvements
        messages: [
          {
            role: 'system',
            content: this.getSystemPrompt()
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1, // Low temperature for consistent code changes
        max_tokens: 1000
      });

      const result = response.choices[0].message.content;
      return this.parseResponse(result, nibbleContext);

    } catch (error) {
      console.error('Error analyzing NIBBLE:', error.message);
      return null;
    }
  }

  /**
   * Extracts surrounding code context around a NIBBLE comment
   * @param {string} fileContent - Full file content
   * @param {number} nibbleLineIndex - Line index of the NIBBLE comment
   * @param {number} contextLines - Number of lines to include on each side
   * @returns {Object} Context information
   */
  extractContext(fileContent, nibbleLineIndex, contextLines = 10) {
    const lines = fileContent.split('\n');
    const contextStart = Math.max(0, nibbleLineIndex - contextLines);
    const contextEnd = Math.min(lines.length, nibbleLineIndex + contextLines);
    
    const surroundingCode = lines.slice(contextStart, contextEnd).join('\n');
    const nibbleComment = lines[nibbleLineIndex];
    
    return {
      surroundingCode,
      nibbleComment,
      contextStart,
      contextEnd,
      totalLines: lines.length
    };
  }

  /**
   * Determines programming language from file extension
   * @param {string} filePath - Path to the file
   * @returns {string} Programming language
   */
  detectLanguage(filePath) {
    const extension = filePath.split('.').pop().toLowerCase();
    const languageMap = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'rb': 'ruby',
      'php': 'php',
      'go': 'go',
      'rs': 'rust',
      'cs': 'csharp',
      'html': 'html',
      'css': 'css',
      'md': 'markdown'
    };
    
    return languageMap[extension] || 'text';
  }

  buildPrompt(nibbleContext) {
    return `You are analyzing a NIBBLE comment in a ${nibbleContext.language} file.

NIBBLE comments indicate small improvements that could be made to the code.
Your job is to suggest a simple, focused improvement.

File: ${nibbleContext.file}
NIBBLE Comment: ${nibbleContext.nibbleComment}

Surrounding Code:
\`\`\`${nibbleContext.language}
${nibbleContext.surroundingCode}
\`\`\`

Please suggest a small improvement that addresses the NIBBLE comment.
Focus on:
- Simple, safe changes
- Better readability, error handling, or performance
- Following best practices for ${nibbleContext.language}

Respond with exactly this JSON format:
{
  "canImprove": true/false,
  "title": "Brief description of the improvement",
  "explanation": "Why this improvement helps",
  "searchText": "exact text to find (multi-line ok)",
  "replaceText": "exact replacement text",
  "confidence": 0.1-1.0
}

If you cannot suggest a safe improvement, set "canImprove": false.`;
  }

  getSystemPrompt() {
    return `You are a senior software engineer helping to make small, incremental improvements to codebases.

Key principles:
- Make SMALL changes only (1-10 lines typically)
- Prioritize safety and readability over cleverness
- Preserve existing functionality
- Follow established code patterns
- Be conservative - if unsure, don't change anything
- Only suggest improvements that are clearly beneficial

You specialize in finding opportunities for:
- Adding error handling
- Improving variable names
- Adding helpful comments
- Simplifying complex expressions
- Following language best practices
- Removing obvious code smells

Always respond in valid JSON format.`;
  }

  parseResponse(responseText, nibbleContext) {
    try {
      // Try to extract JSON from the response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      
      // Validate the response structure
      if (!this.isValidResponse(parsed)) {
        throw new Error('Invalid response structure');
      }

      // If can't improve, return null
      if (!parsed.canImprove) {
        return null;
      }

      // Add metadata
      return {
        ...parsed,
        file: nibbleContext.file,
        language: nibbleContext.language,
        originalNibble: nibbleContext.nibbleComment
      };

    } catch (error) {
      console.error('Error parsing AI response:', error.message);
      console.error('Raw response:', responseText);
      return null;
    }
  }

  isValidResponse(response) {
    const required = ['canImprove', 'title', 'explanation', 'searchText', 'replaceText', 'confidence'];
    return required.every(field => response.hasOwnProperty(field)) &&
           typeof response.canImprove === 'boolean' &&
           typeof response.confidence === 'number' &&
           response.confidence >= 0 && response.confidence <= 1;
  }

  /**
   * Validates that the search text exists exactly once in the surrounding code
   * @param {string} surroundingCode - Code context
   * @param {string} searchText - Text to search for
   * @returns {boolean} True if search text exists exactly once
   */
  validateSearchText(surroundingCode, searchText) {
    const occurrences = (surroundingCode.match(new RegExp(this.escapeRegex(searchText), 'g')) || []).length;
    return occurrences === 1;
  }

  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

export default NibbleAI;
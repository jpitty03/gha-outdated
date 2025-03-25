#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const path = require('path');

// Define possible workflow locations
const WORKFLOW_DIRS = [
  '.github/workflows',
  '.gitlab/workflows' // Some repos might use GitLab
];

// Find workflow files
function findWorkflowFiles() {
  const workflowFiles = [];
  
  WORKFLOW_DIRS.forEach(dir => {
    const workflowDir = path.join(process.cwd(), dir);
    
    if (fs.existsSync(workflowDir)) {
      fs.readdirSync(workflowDir).forEach(file => {
        if (file.endsWith('.yml') || file.endsWith('.yaml')) {
          workflowFiles.push(path.join(workflowDir, file));
        }
      });
    }
  });
  
  return workflowFiles;
}

// Extract GitHub Actions used in a file
function extractActions(filePath) {
  try {
    // Read file
    const fileContent = fs.readFileSync(filePath, 'utf8');
    
    // Find all instances of "uses: actions/..."
    const actionMatches = fileContent.match(/uses:\s+actions\/[^\s@]+@[^\s]+/g) || [];
    
    // Extract just the action references
    return actionMatches.map(match => 
      match.replace(/^uses:\s+/, '').trim()
    );
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error.message);
    return [];
  }
}

// Check latest version available for an action
function checkLatestVersion(action) {
  return new Promise((resolve) => {
    // Parse action reference
    const [actionPath, currentVersion] = action.split('@');
    const [owner, repo] = actionPath.split('/');
    
    // Request latest release info from GitHub API
    const request = https.get({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/releases/latest`,
      headers: {
        'User-Agent': 'GitHub-Actions-Version-Checker',
      }
    }, response => {
      let data = '';
      
      response.on('data', chunk => { data += chunk; });
      
      response.on('end', () => {
        try {
          if (response.statusCode === 200) {
            const release = JSON.parse(data);
            const latestVersion = release.tag_name;
            
            // Return result if we found a different version
            if (latestVersion && latestVersion !== currentVersion) {
              resolve({
                action,
                currentVersion,
                latestVersion
              });
            } else {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        } catch (error) {
          resolve(null);
        }
      });
    });
    
    request.on('error', () => resolve(null));
    request.end();
  });
}

// Main function
async function main() {
  console.log('Checking for outdated GitHub Actions...');
  
  // Step 1: Find workflow files
  const workflowFiles = findWorkflowFiles();
  
  if (workflowFiles.length === 0) {
    console.log('No workflow files found in .github/workflows directory.');
    return;
  }
  
  console.log(`Found ${workflowFiles.length} workflow files.`);
  
  // Step 2: Extract GitHub Actions references
  const allActions = [];
  for (const file of workflowFiles) {
    const actions = extractActions(file);
    allActions.push(...actions);
  }
  
  // Step 3: Filter for unique "actions/*" entries
  const uniqueGitHubActions = [...new Set(
    allActions.filter(action => action.startsWith('actions/'))
  )];
  
  console.log(`Found ${uniqueGitHubActions.length} unique GitHub Actions.\n`);
  
  if (uniqueGitHubActions.length === 0) {
    console.log('No GitHub Actions found in workflow files.');
    return;
  }
  
  // Step 4: Check each action for updates (in parallel)
  const checkResults = await Promise.all(
    uniqueGitHubActions.map(action => checkLatestVersion(action))
  );
  
  // Step 5: Filter out null results and show outdated actions
  const outdatedActions = checkResults.filter(Boolean);
  
  // Step 6: Display results
  if (outdatedActions.length > 0) {
    console.log('📢 Outdated Actions:');
    console.log('-----------------');
    
    outdatedActions.forEach(result => {
      console.log(`${result.action}`);
      console.log(`Current: ${result.currentVersion} → Latest: ${result.latestVersion}\n`);
    });
    
    process.exit(1);
  } else {
    console.log('✅ All GitHub Actions are up to date!');
  }
}

// Run the script
main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});

#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const majorOnly = args.includes('-m') || args.includes('-M') || args.includes('--major');
const showHelp = args.includes('-h') || args.includes('-H') || args.includes('--help');

// Show help if requested
if (showHelp) {
  console.log(`
gha-outdated - Check for outdated GitHub Actions in workflow files

Usage:
  npx gha-outdated [options]

Options:
  -m, -M, --major    Only check for major version updates
  -h, -H, --help     Show this help message

Example:
  npx gha-outdated -m    # Only show actions with major version updates
  `);
  process.exit(0);
}

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
    
    // Find all instances of "uses: owner/repo@version"
    // This matches any GitHub action, not just actions/*
    const actionMatches = fileContent.match(/uses:\s+[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+@[^\s]+/g) || [];
    
    // Extract just the action references
    return actionMatches.map(match => 
      match.replace(/^uses:\s+/, '').trim()
    );
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error.message);
    return [];
  }
}

// Parse version string to get major version number
function getMajorVersion(version) {
  // Remove 'v' prefix if present
  if (version.startsWith('v')) {
    version = version.substring(1);
  }
  
  // Get first number from version string
  const majorMatch = version.match(/^(\d+)/);
  return majorMatch ? parseInt(majorMatch[1], 10) : null;
}

// Check if this is a major version update
function isMajorUpdate(currentVersion, latestVersion) {
  const currentMajor = getMajorVersion(currentVersion);
  const latestMajor = getMajorVersion(latestVersion);
  
  // If we can't parse either version, be conservative and return false
  if (currentMajor === null || latestMajor === null) {
    return false;
  }
  
  return latestMajor > currentMajor;
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
        'User-Agent': 'request',
      }
    }, response => {
      let data = '';
      
      response.on('data', chunk => { data += chunk; });
      
      response.on('end', () => {
        try {
          if (response.statusCode === 200) {
            const release = JSON.parse(data);
            const latestVersion = release.tag_name;
            
            // Check if versions are different
            if (latestVersion && latestVersion !== currentVersion) {
              // If major-only flag is set, check if this is a major update
              if (majorOnly && !isMajorUpdate(currentVersion, latestVersion)) {
                resolve(null); // Skip non-major updates
              } else {
                resolve({
                  action,
                  currentVersion,
                  latestVersion,
                  isMajor: isMajorUpdate(currentVersion, latestVersion)
                });
              }
            } else {
              resolve(null);
            }
          } else if (response.statusCode === 404) {
            console.log(`Repository not found: ${owner}/${repo}`);
            resolve(null);
          } 
          else if (response.statusCode === 403) {
            console.log(`Github API Rate limit exceeded: ${owner}/${repo} \n Please wait 60 minutes and try again\n`);
            resolve(null);
          } else {
            console.log(`API error for ${action}: ${response.statusCode}`);
            resolve(null);
          }
        } catch (error) {
          console.error(`Error processing ${action}:`, error.message);
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
  if (majorOnly) {
    console.log('Mode: Major version updates only');
  }
  
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
  
  // Step 3: Filter for unique entries (no longer filtering for actions/*)
  const uniqueActions = [...new Set(allActions)];
  
  console.log(`Found ${uniqueActions.length} unique GitHub Actions.\n`);
  
  if (uniqueActions.length === 0) {
    console.log('No GitHub Actions found in workflow files.');
    return;
  }
  
  // Step 4: Check each action for updates (in parallel)
  const checkResults = await Promise.all(
    uniqueActions.map(action => checkLatestVersion(action))
  );
  
  // Step 5: Filter out null results and show outdated actions
  const outdatedActions = checkResults.filter(Boolean);
  
  // Step 6: Display results
  if (outdatedActions.length > 0) {
    console.log('📢 Outdated Actions:');
    console.log('-----------------');
    
    outdatedActions.forEach(result => {
      const versionLabel = result.isMajor ? '⚠️  MAJOR UPDATE' : 'Update available';
      console.log(`${result.action} (${versionLabel})`);
      console.log(`Current: ${result.currentVersion} → Latest: ${result.latestVersion}\n`);
    });
    
    process.exit(1);
  } else {
    if (majorOnly) {
      console.log('✅ No major version updates found for GitHub Actions!');
    } else {
      console.log('✅ All GitHub Actions are up to date!');
    }
  }
}

// Run the script
main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});

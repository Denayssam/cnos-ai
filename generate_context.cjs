const fs = require('fs');
const path = require('path');

// 🛠️ CONFIGURATION
const OUTPUT_FILE = 'cnos_full_context.txt';
const PACKAGE_JSON_PATH = path.join(__dirname, 'package.json');

// 🛡️ The Ignore List
const IGNORE_DIRS = [
    'node_modules', '.git', 'dist', 'build', 'coverage', 
    '.firebase', '.github', '.vscode', 'public/assets'
];

const IGNORE_FILES = [
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.DS_Store', 'thumbs.db',
    path.basename(__filename), // Ignore this script itself
    OUTPUT_FILE, 
    '.env.local', 'firebase-debug.log', 'ui-debug.log'
];

// 📄 Extensions to Capture
const ALLOWED_EXTENSIONS = [
    '.js', '.jsx', '.ts', '.tsx', '.css', '.html', 
    '.json', '.rules', '.indexes', '.env', '.md'
];

// --- 🧠 INTELLIGENCE MODULES ---

function getAppMetadata() {
    try {
        if (!fs.existsSync(PACKAGE_JSON_PATH)) {
            return { name: 'Unknown App', version: '0.0.0', stack: 'Unknown' };
        }
        const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
        
        // Detect Stack based on dependencies
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        let stack = [];
        if (deps['react']) stack.push('React');
        if (deps['vue']) stack.push('Vue');
        if (deps['next']) stack.push('Next.js');
        if (deps['firebase']) stack.push('Firebase');
        if (deps['tailwindcss']) stack.push('Tailwind');
        if (deps['typescript']) stack.push('TypeScript');
        
        return {
            name: pkg.name || 'Unnamed Project',
            version: pkg.version || '0.0.0',
            description: pkg.description || 'No description provided.',
            stack: stack.join(' + ') || 'Vanilla JS'
        };
    } catch (e) {
        return { name: 'Error Parsing JSON', version: '0.0.0', stack: 'Error' };
    }
}

function getAllFiles(dirPath, arrayOfFiles) {
    const files = fs.readdirSync(dirPath);
    arrayOfFiles = arrayOfFiles || [];

    files.forEach(function(file) {
        const fullPath = path.join(dirPath, file);
        if (fs.statSync(fullPath).isDirectory()) {
            if (!IGNORE_DIRS.includes(file)) {
                arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
            }
        } else {
            if ((ALLOWED_EXTENSIONS.includes(path.extname(file)) || file === '.env') && !IGNORE_FILES.includes(file)) {
                arrayOfFiles.push(fullPath);
            }
        }
    });
    return arrayOfFiles;
}

function safeRead(filePath, content) {
    if (path.basename(filePath) === '.env' || filePath.endsWith('.local')) {
        return content.split('\n').map(line => {
            if (!line || line.trim().startsWith('#')) return line;
            const parts = line.split('=');
            if (parts.length > 1) {
                const key = parts[0];
                return `${key}=[SECURE_REDACTED]`; 
            }
            return line;
        }).join('\n');
    }
    return content;
}

// --- 🚀 EXECUTION MAIN ---

console.log('🔍 CNOS Scanner Initialized...');
const metadata = getAppMetadata();
console.log(`🤖 Detected App: ${metadata.name} (${metadata.stack})`);

const allFiles = getAllFiles(__dirname);

// --- HEADER GENERATION (The "Gem" Hook) ---
let content = `[SYSTEM_MANIFEST]
APP_NAME: ${metadata.name}
APP_VERSION: ${metadata.version}
TECH_STACK: ${metadata.stack}
DESCRIPTION: ${metadata.description}
GENERATED_AT: ${new Date().toISOString()}
[/SYSTEM_MANIFEST]

[CODEBASE_START]
`;

// --- CONTENT DUMP ---
allFiles.forEach(filePath => {
    try {
        let fileContent = fs.readFileSync(filePath, 'utf8');
        const relativePath = path.relative(__dirname, filePath);
        
        fileContent = safeRead(filePath, fileContent);

        content += `\n================================================================================\n`;
        content += `FILE PATH: ${relativePath}\n`;
        content += `================================================================================\n`;
        content += `${fileContent}\n\n`;
        
        console.log(`✅ Added: ${relativePath}`);
    } catch (err) { 
        console.error(`❌ Error reading ${filePath}: ${err.message}`); 
    }
});

fs.writeFileSync(OUTPUT_FILE, content);
console.log(`\n🎉 SUCCESS! Context generated at: ${OUTPUT_FILE}`);
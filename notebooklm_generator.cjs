const fs = require('fs');
const path = require('path');

// 🛠️ CONFIGURATION FOR NOTEBOOK LM
const OUTPUT_FILE = 'notebooklm_context.txt';
const PACKAGE_JSON_PATH = path.join(__dirname, 'package.json');

// 🛡️ The Ignore List (Aggressively blocking build & native folders)
const IGNORE_DIRS = [
    'node_modules', '.git', 'dist', 'build', 'coverage', 
    '.firebase', '.github', '.vscode', 'public', 'assets',
    'android', 'ios', '.next', 'out' // <- CRÍTICO: Bloquea las carpetas nativas de Capacitor
];

const IGNORE_FILES = [
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.DS_Store', 'thumbs.db',
    path.basename(__filename), // Ignore this script itself
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
        
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        let stack = [];
        if (deps['react']) stack.push('React');
        if (deps['@capacitor/core']) stack.push('Capacitor');
        if (deps['firebase']) stack.push('Firebase');
        if (deps['tailwindcss']) stack.push('Tailwind');
        
        return {
            name: pkg.name || 'Unnamed Project',
            version: pkg.version || '0.0.0',
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
            // Ignorar archivos de salida anteriores
            if (file.startsWith('notebooklm_context')) return;

            if ((ALLOWED_EXTENSIONS.includes(path.extname(file)) || file === '.env') && !IGNORE_FILES.includes(file)) {
                // Ignorar archivos .min.js o .min.css
                if (!file.includes('.min.')) {
                    arrayOfFiles.push(fullPath);
                }
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
                return `${key}="[SECURE_REDACTED]"`; 
            }
            return line;
        }).join('\n');
    }
    return content;
}

// 🛡️ Anti-Minified / Anti-Base64 Shield
// NotebookLM will crash if a single line is absurdly long
function isMinifiedOrBase64(content) {
    const lines = content.split('\n');
    return lines.some(line => line.length > 3000);
}

function getLanguageTag(ext) {
    switch(ext) {
        case '.js': case '.jsx': return 'javascript';
        case '.ts': case '.tsx': return 'typescript';
        case '.json': return 'json';
        case '.css': return 'css';
        case '.html': return 'html';
        default: return 'text';
    }
}

// --- 🚀 EXECUTION MAIN ---

console.log('🔍 NotebookLM Context Scanner Initialized...');
const metadata = getAppMetadata();
console.log(`🤖 Detected App: ${metadata.name} (${metadata.stack})`);

const allFiles = getAllFiles(__dirname);

// ✂️ CHUNKING LOGIC
const MAX_CHARS_PER_FILE = 500000; // Safe limit for NotebookLM
let fileIndex = 1;
let currentContent = '';

function getHeader(index) {
    return `# 📦 APP MANIFEST\n* **App Name:** ${metadata.name}\n* **Version:** ${metadata.version}\n* **Stack:** ${metadata.stack}\n* **Part:** ${index}\n* **Generated At:** ${new Date().toISOString()}\n\n---\n\n`;
}

currentContent = getHeader(fileIndex);

// --- CONTENT DUMP ---
let skippedFiles = 0;

allFiles.forEach((filePath) => {
    try {
        let fileContent = fs.readFileSync(filePath, 'utf8');
        const relativePath = path.relative(__dirname, filePath);
        
        // Skip files that look like compiled trash
        if (isMinifiedOrBase64(fileContent)) {
            console.log(`⚠️ Skipped (Minified/Base64 detected): ${relativePath}`);
            skippedFiles++;
            return;
        }

        fileContent = safeRead(filePath, fileContent);
        const lang = getLanguageTag(path.extname(filePath));

        // Format for NotebookLM (Markdown)
        let block = `### 📁 FILE: \`${relativePath}\`\n`;
        block += `\`\`\`${lang}\n`;
        block += `${fileContent}\n`;
        block += `\`\`\`\n\n`;

        if (currentContent.length + block.length > MAX_CHARS_PER_FILE) {
            const outputName = OUTPUT_FILE.replace('.txt', `_part${fileIndex}.md`); // Changed to .md for better parsing
            fs.writeFileSync(outputName, currentContent);
            console.log(`\n📁 Chunk ${fileIndex} generated: ${outputName}`);
            
            fileIndex++;
            currentContent = getHeader(fileIndex);
        }

        currentContent += block;
        console.log(`✅ Added: ${relativePath}`);
    } catch (err) { 
        console.error(`❌ Error reading ${filePath}: ${err.message}`); 
    }
});

// Write the final remaining chunk
if (currentContent.trim().length > getHeader(fileIndex).trim().length) {
    const outputName = OUTPUT_FILE.replace('.txt', `_part${fileIndex}.md`); // Changed to .md
    fs.writeFileSync(outputName, currentContent);
    console.log(`\n📁 Chunk ${fileIndex} generated: ${outputName}`);
}

console.log(`\n🎉 SUCCESS! NotebookLM Context split into ${fileIndex} files.`);
if (skippedFiles > 0) {
    console.log(`🛡️ Protected NotebookLM from ${skippedFiles} minified/unreadable files.`);
}
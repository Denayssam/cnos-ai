"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateBuild = validateBuild;
const child_process_1 = require("child_process");
function validateBuild(workspacePath) {
    return new Promise(resolve => {
        (0, child_process_1.exec)('npm run build', { cwd: workspacePath, timeout: 45000 }, (err, stdout, stderr) => {
            if (!err) {
                resolve({ success: true });
            }
            else {
                resolve({ success: false, error: (stderr || stdout).trim().slice(0, 2000) });
            }
        });
    });
}
//# sourceMappingURL=buildValidator.js.map
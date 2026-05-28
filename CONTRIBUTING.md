# Contributing to Blindfold (by Clustr)

Blindfold is a zero-dependency security primitive. By contributing to this repository, you agree to strictly adhere to the engineering mandates outlined below. **Pull Requests that violate these rules will be closed without review.**

## Strict Engineering Mandates

1. **Zero Additional Dependencies:** Running `npm install <package>` for third-party libraries (e.g., `glob`, `picomatch`, `lodash`) is strictly banned. The ONLY permitted external dependency in `package.json` is `dotenv`. 
2. **Native Node.js I/O:** All file searching, directory traversal, and path matching must be written natively using `fs.promises` and JavaScript `RegExp`.
3. **Strict Asynchronous Execution:** Blocking the VS Code Extension Host is a fatal error. Use `fs/promises` exclusively. The use of synchronous functions (e.g., `fs.readFileSync`, `fs.writeFileSync`) is banned.
4. **Cross-Platform Pathing:** Hardcoded slashes (e.g., `/` or `\`) are banned. You must utilize `path.join()`, `path.resolve()`, and `os.homedir()` to ensure execution across Linux, Windows, and macOS.

## Local Development Setup

### Prerequisites
- [Node.js 18+](https://nodejs.org/)
- [VS Code](https://code.visualstudio.com/)

### Installation & Execution
1. **Clone the repository:**
   ```bash
   git clone [https://github.com/YOUR_USERNAME/blindfold-by-clustr.git](https://github.com/YOUR_USERNAME/blindfold-by-clustr.git)
   cd blindfold-by-clustr

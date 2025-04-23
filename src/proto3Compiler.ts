'use strict';

import vscode = require('vscode');
import path = require('path');
import cp = require('child_process');
import * as fs from 'fs';

import { Proto3Configuration } from './proto3Configuration';

export class Proto3Compiler {

    private _config: Proto3Configuration;
    private _isProtocInPath: boolean;

    constructor(workspaceFolder?: vscode.WorkspaceFolder) {
        this._config = Proto3Configuration.Instance(workspaceFolder);
        try {
            cp.execFileSync("protoc", ["-h"]);
            this._isProtocInPath = true;
        } catch (e) {
            this._isProtocInPath = false;
        }
    }

    public compileAllProtos() {
        let args = this._config.getProtocOptions();
        args = args.concat(this._config.getTmpJavaOutOption(),);
        // Compile in batch produces errors. Must be 1 by 1.
        this._config.getAllProtoPaths().forEach(proto => {
            this.runProtoc(args.concat(proto), undefined, (stdout, stderr) => {
                vscode.window.showErrorMessage(stderr);
            });
        })
    }

    public compileActiveProto() {
        let editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId == 'proto3') {
            let fileName = editor.document.fileName;
            let args = this._config.getProtocOptions().concat(fileName);

            this.runProtoc(args, undefined, (stdout, stderr) => {
                vscode.window.showErrorMessage(stderr);
            });
        }
    }

    public compileProtoToTmp(fileName: string, callback?: (stderr: string) => void) {
        let proto = path.relative(vscode.workspace.rootPath, fileName);

        let args = this._config.getProtoPathOptions()
            .concat(this._config.getTmpJavaOutOption(), proto);

        this.runProtoc(args, undefined, (stdout, stderr) => {
            if (callback) {
                callback(stderr);
            }
        });
    }

    private runProtoc(args: string[], opts?: cp.ExecFileOptions, callback?: (stdout: string, stderr: string) => void) {
        let protocPath = this._config.getProtocPath(this._isProtocInPath);
        if (protocPath == "?") {
            return; // protoc is not configured
        }

        const lineMapsByFile: Record<string, number[]> = {};


        // ⬇️ Preprocess .proto3b files
        args = args.map(arg => {
            if (arg.endsWith(".proto")) {
                try {
                    console.log(`[proto3b] Transforming ${arg} to proto3`);
                const originalPath = arg;
                const fullPath = path.isAbsolute(originalPath)
                    ? originalPath
                    : path.join(vscode.workspace.rootPath ?? "", originalPath);

                const workspaceRoot = vscode.workspace.rootPath ?? ".";

                console.log(`[proto3b] Full path: ${fullPath}`);

                if (!fs.existsSync(fullPath)) {
                    vscode.window.showErrorMessage(`File not found: ${fullPath}`);
                    return;
                }

                

                const tmpPath = fullPath.replace(/\.proto$/, ".build.proto");
                // calculate relative path for the file in the .gen folder
                const relativePath = path.relative(workspaceRoot, tmpPath);
                console.log(`[proto3b] Relative path: ${relativePath}`);

                // TODO: Reproduce the path to the .gen folder
                const generalGenDir = path.join(vscode.workspace.rootPath ?? ".", ".gen");
                
                if (!fs.existsSync(generalGenDir)) {
                    fs.mkdirSync(generalGenDir, { recursive: true });
                }

                const genDir = path.join(generalGenDir, path.dirname(relativePath));

                const genPath = path.join(genDir, path.basename(tmpPath));

                console.log(`[proto3b] Generated path: ${genPath}`);
                
                if (!fs.existsSync(genDir)) {
                    fs.mkdirSync(genDir, {recursive: true});
                }
                
                const protoText = fs.readFileSync(fullPath, "utf8");
                const { content: transformed, lineMap } = transformProto3bToProto3(protoText, relativePath);

                fs.writeFileSync(genPath, transformed);

                lineMapsByFile[genPath] = lineMap;

                return path.relative(workspaceRoot, genPath);
                } catch (e) {
                    console.error("Error transforming proto3b to proto3:", e);
                    vscode.window.showErrorMessage("Error transforming proto3b to proto3: " + e.message);
                }
                
            }
            return arg;
        });

        if (!opts) {
            opts = {};
        }

        opts = Object.assign(opts, {
            cwd: vscode.workspace.rootPath,});

        console.log(`[proto3b] Running protoc with args: ${args.join(" ")}`);
        console.log(`[proto3b] Options: ${JSON.stringify(opts)}`);

        cp.execFile(protocPath, args, opts, (err, stdout, stderr) => {
            if (err && stdout.length == 0 && stderr.length == 0) {
                // Assume the OS error if no messages to buffers because
                // "err" does not provide error type info.
                vscode.window.showErrorMessage(err.message);
                console.error(err);
                return;
            }
            if (callback) {
                const channel = vscode.window.createOutputChannel(`proto3-b`);
                channel.appendLine(stdout);
                channel.appendLine(stderr);
                channel.show();


                const errorRegex = /(.+):(\d+):(\d+):\s+(.*)/g;
                let match;
                while ((match = errorRegex.exec(stderr)) !== null) {
                    const [fullMatch, filePath, lineStr, colStr, message] = match;
                    const lineNum = parseInt(lineStr, 10);
                    const colNum = parseInt(colStr, 10);
                    const absolutePath = path.resolve(opts!.cwd ?? "", filePath);

                    if (lineMapsByFile[absolutePath]) {
                        const originalLine = lineMapsByFile[absolutePath][lineNum - 1] ?? lineNum;
                        channel.appendLine(`⚠️ Mapped error: ${filePath}:${lineNum}:${colNum} → original line ${originalLine + 1}`);
                    }
                }



                callback(stdout, stderr);
            }
        });
    }

}

interface TransformationResult {
    content: string;
    lineMap: number[]; // protoLine → proto3bLine
}

function transformProto3bToProto3(content: string, relativePath: string): TransformationResult {
    const lines = content.split("\n");
    const outputLines: string[] = [];
    const lineMap: number[] = [];

    let addedImport = false;
    let addedPackage = false;
    const packageName = path.dirname(relativePath).replace(/\\/g, "/").replace(/\//g, ".").replace(/^\./, "");
    const packageNameLine = `package ${packageName};`;

    console.log(`[proto3b] Package name: ${relativePath.trim() !== ""}`);

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        // Trasforma `syntax = "proto3-b"` → `proto3`
        if (/syntax\s*=\s*"proto3-b"/.test(line)) {
            outputLines.push(line.replace(/"proto3-b"/, '"proto3"'));
            lineMap.push(i);
            continue;
        }

        if (line.startsWith("package")) {
            addedPackage = true;
            continue;
        }

        if (!addedPackage && (packageName.trim() !== "")) {
            outputLines.push('')
            outputLines.push(packageNameLine);
            lineMap.push(i);
            addedPackage = true;
            continue;
        }

        // Trasforma `message X extends Y {`
        const match = line.match(/^\s*message\s+(\w+)\s+extends\s+([\w\.]+)\s*\{/);

        if (match) {
            const [, msgName, baseName] = match;

            console.log(`[proto3b] Found message ${msgName} extending ${baseName}`);

            // Aggiungi l'import solo una volta
            if (!addedImport && !content.includes('import ".gen/utils/ts_proto_options.proto";')) {
                
                outputLines.push('import ".gen/utils/ts_proto_options.proto";');
                outputLines.push('');
                lineMap.push(i); // riferimento alla riga dell'estensione
                addedImport = true;
            }

            outputLines.push(`message ${msgName} {`);
            lineMap.push(i);

            const baseNameSplitted = baseName.split(".");
            const baseNameWithoutModule = baseNameSplitted.pop() ?? baseName;

            const module = baseNameSplitted.join(".");

            outputLines.push(`  option (ts_proto_options.mixins) = ".gen/${module}/${baseNameWithoutModule}.proto";`);
            lineMap.push(i);
            continue;
        }

        if (addedImport) {

            ensureTsProtoOptionsExists();
        }

        // Altrimenti, copia la riga così com'è
        outputLines.push(line);
        lineMap.push(i);
    }

    return {
        content: outputLines.join("\n"),
        lineMap
    };
}

function ensureTsProtoOptionsExists(): void {
    try {
        const workspaceRoot = vscode.workspace.rootPath ?? ".";
        const protoPath = path.join(workspaceRoot, ".gen", "utils", "ts_proto_options.proto");

        console.log(`[proto3b] Checking for ts_proto_options.proto at ${protoPath}`);

        if (!fs.existsSync(protoPath)) {
            const dir = path.dirname(protoPath);
            fs.mkdirSync(dir);

            const contents = `syntax = "proto3";
  
import "google/protobuf/descriptor.proto";

package ts_proto_options;

extend google.protobuf.MessageOptions {
string mixins = 50001;
}
  `;
            fs.writeFileSync(protoPath, contents, "utf8");
            console.log(`[proto3b] Created missing ts_proto_options.proto`);
        }
    } catch (error) {
        console.error("Error creating ts_proto_options.proto:", error);
        vscode.window.showErrorMessage("Error creating ts_proto_options.proto: " + error.message);
    }

}

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export interface CTagEntry {
    name: string;
    file: string;
    kind?: string;
    address: {
        pattern?: string;
        lineNumber: number;
    };
}

/**
 * 解析一行 tags 条目
 */
function parseTagLine(line: string): CTagEntry | null {
    if (line.startsWith('!_')) return null; // 跳过伪标签
    const parts = line.split('\t');
    if (parts.length < 3) return null;
    const [name, file, patternRest] = parts;
    let pattern: string | undefined;
    let lineNumber = 0;

    // 提取模式（可能是 /pattern/ 或数字）
    if (patternRest[0] === '/' || patternRest[0] === '?') {
        const delimiter = patternRest[0];
        let end = 1;
        while (end < patternRest.length && patternRest[end] !== delimiter) {
            if (patternRest[end] === '\\') end++; // 跳过转义符
            end++;
        }
        pattern = patternRest.substring(1, end);
    } else if (/^\d+/.test(patternRest)) {
        lineNumber = parseInt(patternRest.match(/^\d+/)![0], 10);
    } else {
        return null;
    }

    // 解析扩展字段（可选）
    let kind: string | undefined;
    const extStart = patternRest.indexOf(';"');
    if (extStart !== -1) {
        const ext = patternRest.substring(extStart + 2);
        const fields = ext.split('\t');
        for (const f of fields) {
            const [key, value] = f.split(':');
            if (key === 'kind') kind = value;
        }
    }

    return {
        name,
        file,
        kind,
        address: {
            pattern,
            lineNumber
        }
    };
}

/**
 * 在指定的 tags 文件中查找标签（线性搜索）
 */
async function findTagsInFile(tagsPath: string, tagName: string): Promise<CTagEntry[]> {
    return new Promise<CTagEntry[]>((resolve, reject) => {
        const matches: CTagEntry[] = [];
        const fileStream = fs.createReadStream(tagsPath, { encoding: 'utf8' });
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        fileStream.on('error', reject);
        rl.on('line', (line: string) => {
            const entry = parseTagLine(line);
            if (entry && entry.name === tagName) {
                matches.push(entry);
            }
        });
        rl.on('close', () => resolve(matches));
    });
}

function parseTagFilePatterns(tagFilePattern: string): string[] {
    const braceMatch = tagFilePattern.match(/^\{([^}]*)\}(.+)$/);
    if (braceMatch) {
        const [, prefixes, suffix] = braceMatch;
        return prefixes
            .split(',')
            .map(prefix => `${prefix}${suffix}`.trim())
            .filter(Boolean);
    }

    return tagFilePattern
        .split(',')
        .map(pattern => pattern.trim())
        .filter(Boolean);
}

function matchesTagFilePattern(fileName: string, pattern: string): boolean {
    if (!pattern.includes('*')) {
        return fileName === pattern;
    }

    const escapedPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');

    return new RegExp(`^${escapedPattern}$`).test(fileName);
}

/**
 * 向上查找 tags 文件
 * @param searchPath 搜索起始路径（文件或目录）
 * @param tagFilePattern tags 文件名模式（逗号分隔）
 */
async function findCTagsFile(
    searchPath: string,
    tagFilePattern: string = '{.,}tags'
): Promise<string | null> {
    const patterns = parseTagFilePatterns(tagFilePattern);
    let currentPath = path.resolve(searchPath);

    try {
        if (fs.statSync(currentPath).isFile()) {
            currentPath = path.dirname(currentPath);
        }
    } catch (err) {
        return null;
    }

    while (true) {
        try {
            const files = fs.readdirSync(currentPath);
            for (const file of files) {
                for (const pattern of patterns) {
                    if (matchesTagFilePattern(file, pattern)) {
                        const fullPath = path.join(currentPath, file);
                        const stat = fs.statSync(fullPath);
                        if (stat.isFile()) {
                            return fullPath;
                        }
                    }
                }
            }
        } catch (err) {
            // 目录不存在或无法读取，跳出循环
            break;
        }
        const parent = path.dirname(currentPath);
        if (parent === currentPath) break; // 到达根目录
        currentPath = parent;
    }
    return null;
}

/**
 * 查找 tags 文件并搜索指定标签
 * @param searchPath 搜索起始路径（文件或目录）
 * @param tag 要搜索的标签名
 * @param ignoreCase 是否忽略大小写（当前版本未实现，保留参数以兼容原接口）
 * @param tagFilePattern tags 文件名模式
 */
export async function findCTagsBSearch(
    searchPath: string,
    tag: string,
    ignoreCase: boolean = false,
    tagFilePattern: string = '{.,}tags'
): Promise<{ tagsFile: string; results: CTagEntry[] }> {
    void ignoreCase;
    const tagsFile = await findCTagsFile(searchPath, tagFilePattern);
    if (!tagsFile) {
        return { tagsFile: '', results: [] };
    }
    const results = await findTagsInFile(tagsFile, tag);
    // 注意：results 中的 file 是相对路径（相对于 tags 文件所在目录），调用方会自己处理绝对化
    return { tagsFile, results };
}

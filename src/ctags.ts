import * as fs from 'fs';
import { promises as fsp } from 'fs';
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
 * 还原 ctags 在 pattern 中转义的字符（分隔符、反斜杠、\t）
 */
function unescapePattern(pattern: string, delimiter: string): string {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\' && i + 1 < pattern.length) {
            const next = pattern[i + 1];
            if (next === delimiter || next === '\\' || next === 't') {
                out += next === 't' ? '\t' : next;
                i++;
                continue;
            }
        }
        out += ch;
    }
    return out;
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
    // 扩展字段（kind 等）所在的起始下标，-1 表示没有
    let extFields: string | undefined;

    // 提取模式（可能是 /pattern/ 或数字）
    if (patternRest[0] === '/' || patternRest[0] === '?') {
        const delimiter = patternRest[0];
        let end = 1;
        while (end < patternRest.length && patternRest[end] !== delimiter) {
            if (patternRest[end] === '\\') end++; // 跳过转义符
            end++;
        }
        if (end >= patternRest.length) return null; // 没有闭合分隔符，行损坏
        // 还原 ctags 转义过的字符，得到字面 pattern
        pattern = unescapePattern(patternRest.substring(1, end), delimiter);
        // 扩展字段紧跟在闭合分隔符之后（";"），避免命中 pattern 内部的 ;"
        const extStart = patternRest.indexOf(';"', end);
        if (extStart !== -1) {
            extFields = patternRest.substring(extStart + 2);
        }
    } else if (/^\d+/.test(patternRest)) {
        lineNumber = parseInt(patternRest.match(/^\d+/)![0], 10);
        const extStart = patternRest.indexOf(';"');
        if (extStart !== -1) {
            extFields = patternRest.substring(extStart + 2);
        }
    } else {
        return null;
    }

    // 解析扩展字段（可选）
    let kind: string | undefined;
    if (extFields !== undefined) {
        const fields = extFields.split('\t');
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
 * 在指定的 tags 文件中按行扫描查找标签（线性搜索，用于未排序文件）
 */
async function findTagsInFileLinear(tagsPath: string, tagName: string): Promise<CTagEntry[]> {
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
        rl.on('error', () => {
            rl.close();
            fileStream.destroy();
            reject(new Error(`Failed to read tags file: ${tagsPath}`));
        });
    });
}

const READ_CHUNK_SIZE = 16 * 1024;
const MAX_TAG_LINE_LENGTH = 64 * 1024;

interface TagLineAt {
    line: string;
    start: number; // 行首字节偏移
    end: number; // 行尾（换行符之后）字节偏移
}

/**
 * 读取包含指定字节偏移的那一行（offset 落在行中间时返回该行本身）。
 */
async function readLineAt(fd: fs.promises.FileHandle, offset: number, size: number): Promise<TagLineAt | null> {
    if (offset < 0 || offset >= size) return null;

    // 向前找包含该偏移的行首
    let lineStart = 0;
    if (offset > 0) {
        const backLen = Math.min(READ_CHUNK_SIZE, offset);
        const backBuf = Buffer.alloc(backLen);
        await fd.read(backBuf, 0, backLen, offset - backLen);
        const nl = backBuf.lastIndexOf('\n');
        if (nl === -1 && offset - backLen > 0) return null; // 行超长（超过回看窗口），放弃
        lineStart = nl === -1 ? 0 : offset - backLen + nl + 1;
    }

    // 从行首向后读到行尾
    let buf = Buffer.alloc(0);
    let pos = lineStart;
    const readMore = async (): Promise<void> => {
        const chunk = Buffer.alloc(Math.min(READ_CHUNK_SIZE, size - pos));
        const { bytesRead } = await fd.read(chunk, 0, chunk.length, pos);
        if (bytesRead > 0) {
            buf = Buffer.concat([buf, chunk.subarray(0, bytesRead)]);
            pos += bytesRead;
        }
    };
    await readMore();

    let endIdx = buf.indexOf('\n');
    while (endIdx === -1 && pos < size && buf.length < MAX_TAG_LINE_LENGTH) {
        await readMore();
        endIdx = buf.indexOf('\n');
    }
    let lineBuf: Buffer;
    let end: number;
    if (endIdx === -1) {
        // EOF，最后一行可能没有换行符
        lineBuf = buf;
        end = lineStart + buf.length;
    } else {
        lineBuf = buf.subarray(0, endIdx);
        end = lineStart + endIdx + 1;
    }
    if (lineBuf.length && lineBuf[lineBuf.length - 1] === 13) {
        lineBuf = lineBuf.subarray(0, -1); // 去掉 \r
    }
    return { line: lineBuf.toString('utf8'), start: lineStart, end };
}

function compareName(a: string, b: string): number {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * 检查 tags 文件的排序标记（!_TAG_FILE_SORTED）。
 * 返回标记值：1 = 已排序，0 = 未排序，2 = 忽略大小写排序；无标记时默认视为已排序。
 */
async function getSortedFlag(fd: fs.promises.FileHandle, size: number): Promise<number> {
    // 伪标签位于文件开头，检查前几行即可
    let cur = 0;
    for (let i = 0; i < 10; i++) {
        const at = await readLineAt(fd, cur, size);
        if (!at) break;
        if (!at.line.startsWith('!_')) break;
        if (at.line.startsWith('!_TAG_FILE_SORTED')) {
            const m = at.line.split('\t')[1];
            const val = parseInt(m, 10);
            return Number.isNaN(val) ? 1 : val;
        }
        cur = at.end;
    }
    return 1;
}

/**
 * 在指定的 tags 文件中查找标签。
 * tags 文件默认按标签名排序（ctags --sort=yes），使用二分查找定位后向两侧扩展收集同名条目；
 * 未排序的文件回退到线性扫描。
 */
async function findTagsInFile(tagsPath: string, tagName: string): Promise<CTagEntry[]> {
    const fd = await fsp.open(tagsPath, 'r');
    try {
        const size = (await fd.stat()).size;
        const sortedFlag = await getSortedFlag(fd, size);
        if (sortedFlag !== 1) {
            return findTagsInFileLinear(tagsPath, tagName);
        }

        let lo = 0;
        let hi = size;
        let found: TagLineAt | null = null;

        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const at = await readLineAt(fd, mid, size);
            if (!at) {
                hi = mid;
                continue;
            }
            const entry = parseTagLine(at.line);
            const cmp = compareName(entry ? entry.name : '', tagName);
            if (cmp === 0) {
                found = at;
                break;
            }
            if (cmp < 0) {
                lo = Math.max(at.end, mid + 1);
            } else {
                hi = at.start;
            }
        }
        if (!found) return [];

        // 向前回退到第一个同名条目
        let first = found;
        while (first.start > 0) {
            const prev = await readLineAt(fd, first.start - 1, size);
            if (!prev) break;
            const entry = parseTagLine(prev.line);
            if (entry && entry.name === tagName) {
                first = prev;
            } else {
                break;
            }
        }

        // 从第一个同名条目向后顺序收集
        const matches: CTagEntry[] = [];
        let cur: TagLineAt | null = first;
        while (cur) {
            const entry = parseTagLine(cur.line);
            if (entry && entry.name === tagName) {
                matches.push(entry);
                cur = cur.end >= size ? null : await readLineAt(fd, cur.end, size);
            } else {
                break;
            }
        }
        return matches;
    } finally {
        await fd.close();
    }
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

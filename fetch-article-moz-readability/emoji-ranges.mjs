import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let cachedRanges = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// to regenerate the ranges whenever there is a new emoji unicode version update:
//   in ~: git clone --filter=blob:none --depth=1 --single-branch https://github.com/googlefonts/noto-emoji.git
//   here: ls -1 ~/noto-emoji/png/72 | egrep -v "emoji_u1?[0-9a-f]{4}_" | grep -v emoji_u00 | egrep -v "emoji_u1f...\.png" | sort | python3 contig.py > noto-ranges.txt
//         echo U+1F000-U+1FFFF >> noto-ranges.txt

// Example usage
const NOTO_RANGES_PATH = path.join(__dirname, 'noto-ranges.txt');

function loadRanges() {
    if (cachedRanges !== null) {
        return cachedRanges;
    }

    const ranges = [];
    const data = fs.readFileSync(NOTO_RANGES_PATH, 'utf8');
    const lines = data.split(/\r?\n/);

    for (const line of lines) {
        if (line.trim() === '') continue;

        if (line.includes('-')) {
            const [start, end] = line.split('-').map(part => parseInt(part.replace('U+', ''), 16));
            ranges.push({ start, end });
        } else {
            const value = parseInt(line.replace('U+', ''), 16);
            ranges.push({ start: value, end: value });
        }
    }

    cachedRanges = ranges;
    return ranges;
}

function isCharacterInRange(character, filePath) {
    const charCode = character.codePointAt(0);
    const ranges = loadRanges();

    for (const range of ranges) {
        if (charCode >= range.start && charCode <= range.end) {
            return true;
        }
    }

    return false;
}

export {
    isCharacterInRange
};

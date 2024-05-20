import fs from 'fs-extra';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import PQueue from 'p-queue';
import { isCharacterInRange } from './emoji-ranges.mjs';
import util from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function notoCacheDir() {
    return path.resolve("/home/lypanov/hardcopy", 'noto_cache');
}

async function preprocess(input) {
    await fs.ensureDir(notoCacheDir());

    const queue = new PQueue({ concurrency: 4 });

    for (const char of input) {
        queue.add(async () => {
            const codePoint = char.codePointAt(0);
            if (/^[\p{Extended_Pictographic}]$/gu.test(char) && isCharacterInRange(char)) {
                const hexCode = `u${codePoint.toString(16)}`;
                const fileName = `${hexCode}_72.png`;
                const filePath = path.join(notoCacheDir(), fileName);
                const url = `https://github.com/googlefonts/noto-emoji/raw/main/png/72/emoji_${hexCode}.png`;

                if (!await fs.pathExists(filePath)) {
                    const response = await axios({
                        url,
                        responseType: 'arraybuffer',
                        validateStatus: false,
                    });

                    if (response.status === 200) {
                        const resizedImage = response.data;
                        await fs.writeFile(filePath, resizedImage);
                        console.log(`Downloaded new emoji: ${filePath}`);
                    } else {
                        console.error(`Failed to download: ${url}`);
                    }
                }
            }
        });
    }

    await queue.onIdle();
}

function processString(input) {
    const outputMarkdown = [];

    for (const char of input) {
        const codePoint = char.codePointAt(0);
        if (/^[\p{Extended_Pictographic}]$/gu.test(char) && isCharacterInRange(char)) {
            const hexCode = `u${codePoint.toString(16)}`;
            const fileName = `${hexCode}_72.png`;
            outputMarkdown.push(`<img class="emoji-font" src="../noto_cache/${fileName}" alt="${char}">`);
        } else {
            outputMarkdown.push(char);
        }
    }

    return outputMarkdown.join('');
}

export {
    preprocess,
    processString
};


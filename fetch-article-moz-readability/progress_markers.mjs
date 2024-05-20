// vim: set sw=4 ts=4 sts=4 expandtab:
//
import fs from 'fs';
import path from 'path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import minimist from 'minimist';
import { preprocess, processString } from './async-emoji.mjs'
import { toMarkdown } from 'mdast-util-to-markdown';

// Helper function to count words
function countWords(text) {
    return text.split(/\s+/).filter(word => word.length > 0).length;
}

// Helper function to add progress markers
async function addProgressMarkers(tree, thresholds, globalWordCount, startWordCount, emojis) {
    let wordCount = startWordCount;

    function visitor(node) {
        if (node.type === 'text') {
            wordCount += countWords(node.value);

            const parts = node.value.split( /([\p{Extended_Pictographic}])/gu);
            if (emojis && parts.length > 1) {
                // console.log("rewriting parts", parts);
                const nodes = [];

                for (const part of parts) {
                    // TODO check against a run of emoji's rather than just the one
                    //   we want every single one to come in independently
                    if (/^[\p{Extended_Pictographic}]$/gu.test(part)) {
                        nodes.push({
                            type: 'html',
                            // TODO this is nonsense, lot's of duplicate work
                            //   given we're anyway splitting the screen here
                            //   processString itself should just covert a
                            //   single code point
                            value: processString(part)
                        });
                    } else if (part.length > 0) {
                        nodes.push({
                            type: 'text',
                            value: part
                        });
                    }
                }

                return nodes;
            }
        }

        if (node.type === 'paragraph' && globalWordCount.nextThresholdIndex < thresholds.length && wordCount >= thresholds[globalWordCount.nextThresholdIndex]) {
            node.children.push({
                type: 'text',
                value: `\n\nAlex, you're at ${Math.round((wordCount / globalWordCount.totalWords) * 100)}% now.\n`
            });
            globalWordCount.nextThresholdIndex++;
        }

        return node;
    }

    function transform(node) {
        if (Array.isArray(node.children)) {
            node.children = node.children.flatMap(child => {
                const result = visitor(child);
                transform(child);
                return Array.isArray(result) ? result : [result];
            });
        }
    }

    globalWordCount.current = wordCount; // Update the global word count
    return transform(tree);
}

async function fart(filePaths, contents) {
    // TODO would be nice to remove the need for the massive concat
    //   by  having the queue management optionally coming from here?
    var all = "";
    for (let i = 0; i < filePaths.length; i++) {
        const content = contents[i];
        const filePath = filePaths[i];
        all += content;
    }
    return preprocess(all);
}

function customCompiler() {
  this.Compiler = (tree) => {
    // TODO blergh
    const options = { ruleSpaces: true, emphasis: '_', listItemIndent: 'tab' };
    return toMarkdown(tree, options).replaceAll(/\\(?![^a-zA-Z])/g, "\\\\");
  };
}

async function addMarkersToMarkdown(filePaths, emojis) {
    const contents = await Promise.all(filePaths.map(filePath => fs.promises.readFile(filePath, 'utf8')));
    const wordCounts = contents.map(content => countWords(content));
    const totalWords = wordCounts.reduce((sum, count) => sum + count, 0);

    var emojiDownloader;
    if (emojis) {
        emojiDownloader = fart(filePaths, contents);
    }

    // Calculate cumulative word counts at the start of each file
    const cumulativeWordCounts = wordCounts.reduce((acc, count) => {
        acc.push((acc.length ? acc[acc.length - 1] : 0) + count);
        return acc;
    }, []);

    const percentages = [16.7, 33, 50, 66, 83];
    const thresholds = percentages.map(p => Math.round((p / 100) * totalWords));
    // TODO is it really okay for this to be a const? wtf?
    const globalWordCount = { current: 0, totalWords, nextThresholdIndex: 0 };

    for (let i = 0; i < filePaths.length; i++) {
        const content = contents[i];
        const filePath = filePaths[i];
        const startWordCount = i > 0 ? cumulativeWordCounts[i - 1] : 0;

        const processor = unified()
            .use(remarkParse)
            .use(() => tree => addProgressMarkers(tree, thresholds, globalWordCount, startWordCount, emojis))
            .use(customCompiler);

        // .use(remarkStringify, options);

        const file = await processor.process(content);
        // remove rdoff from file name automatically in the case the input was rdoff
        var outputFilePath = `${path.dirname(filePath)}/${path.basename(filePath, ".md")}.marked.md`.replace(".rdoff", "");
        if (emojis) {
            outputFilePath = outputFilePath.replace(".md", ".emoji.md")
        }
        await fs.promises.writeFile(outputFilePath, String(file));

        console.log(`Progress markers added. Output written to ${outputFilePath}`);
    }

    // return only once all emoji have finished download,
    //   this can feasibly be postponed even longer when
    //   the whole thing is a ES module and the promise can
    //   be passed back higher up
    if (emojis) {
        console.log("Awaiting remaining emojis (if any).");
        await emojiDownloader;
    }
}

// Get file paths from command line arguments
const args = minimist(process.argv.slice(2));
var filePaths = args._;

if (filePaths.length === 0) {
    console.error('Please provide at least one markdown file.');
    process.exit(1);
}

if (args.rdoff == "true") {
    filePaths = filePaths.map(filePath => filePath.replace(".md", ".rdoff.md"));
    console.log("replacement!", filePaths);
}
var emojis = false;
if (args.emojis == "true") {
    console.log("emojis being genned");
    emojis = true;
}

addMarkersToMarkdown(filePaths, emojis);

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const process = require('process');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const { BASE62, base62encode } = require('./base62');

var links = [];

// TODO ~
const baseDir = '/home/lypanov/hardcopy';

function parseYearWeekDir(dir) {
    const match = dir.match(/^(\d{4})\^(\d{2})$/);
    if (match) {
        const year = parseInt(match[1], 10);
        const week = parseInt(match[2], 10);
        return { year, week, dir };
    }
    return null;
}

// ^^^^ verify the sort actually works
const dateDirs = fs.readdirSync(baseDir)
      .filter(dir => fs.lstatSync(path.join(baseDir, dir)).isDirectory())
      .map(dir => parseYearWeekDir(dir))
      .filter(parsed => parsed !== null) // skip other dirs
      .sort((a, b) => {
          if (b.year !== a.year) {
              return b.year - a.year; // Sort by year in descending order
          }
          return b.week - a.week; // Sort by week in descending order if years are equal
      })
      .map(parsed => parsed.dir);

// thx to ChatGPT for feasibly copying this from someone
const misinterpretedChars = {
    'Â': '',          // non-breaking space (U+00A0)
    'â€“': '–',       // en dash (U+2013)
    'â€˜': '‘',       // left single quotation mark (U+2018)
    'â€™': '’',       // right single quotation mark (U+2019)
    'â€œ': '“',       // left double quotation mark (U+201C)
    'â€�': '”',       // right double quotation mark (U+201D)
    'â€²': '′',       // prime (U+2032)
    'â€³': '″',       // double prime (U+2033)
    'ã€�': '【',      // left white lenticular bracket (U+3010)
    'ã€‘': '】'       // right white lenticular bracket (U+3011)
};

const misinterpretedCharsRegex = new RegExp(Object.keys(misinterpretedChars).join('|'), 'g');

function fixLatin1Missinterpretation(text) {
    // this complete oddness is required due to pushbullet / chrome deciding
    //   that the content sent from the boox device is in latin1 rather
    //   than utf8 (AFAICT)
    return text.replace(misinterpretedCharsRegex, match => misinterpretedChars[match]);
}

function matchIdentifiers(text, allowWithoutBraces) {
    const regexNoBracesRequired = new RegExp(`\\b([${BASE62}]{3})\\b`, 'g');
    const regexBracesRequired = new RegExp(`\{([${BASE62}]{3})\}`, 'g');
    const matchCaptures = text.matchAll(allowWithoutBraces ? regexNoBracesRequired : regexBracesRequired) || [];
    const arr = [...matchCaptures];
    const foo = arr.map(t =>  { return t[1] } )
    return foo;
}

function findShortcodes(lookingFors) {
    var newLinks = [];
    for (const dateDir of dateDirs) {
        const mdFiles = fs.readdirSync(path.join(baseDir, dateDir))
              .filter(file => path.extname(file) === '.md');

        for (const mdFile of mdFiles) {
            const filePath = path.join(baseDir, dateDir, mdFile);
            const content = fs.readFileSync(filePath, 'utf8');
            const linkRegex = /\[(.+?)\]\((.+?)\) \{(.*?)\}/g;
            let match;
            // comment out when you fucked up and are doing a cycle on Monday still and links make no sense
            // if (newLinks.length > 0) { break; }

            while ((match = linkRegex.exec(content)) !== null) {
                const [, , href, shortcode ] = match;
                if (lookingFors.includes(shortcode)) {
                    // each match hits many times for the same shortcode so skip them
                    //   (unsure why, but assume due to the way it's constructed, maybe reducing
                    //    the number of captures works around this in a neater way?)
                    if (!newLinks.includes(href)) {
                        // console.log(`Shortcode '${shortcode}' found in ${filePath}.\nFull link: ${href}`);
                        newLinks.push(href);
                    }
                }
            }
        }
    }
    return newLinks;
}

const SECTION_HEADER_REGEXP = /\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}  \|  Page No\.\: \d+\b/;

var assumeEvie = false;
var assumeBoox = false
var textQueue = [];

function linksElseGoogle(links, _text, allowWithoutBraces) {
    var text = fixLatin1Missinterpretation(_text);
    const matches = matchIdentifiers(text, allowWithoutBraces);
    const matchedShortcodesLinks = findShortcodes(matches);
    if (matchedShortcodesLinks.length > 0 && !assumeEvie && !assumeBoox) {
        links.push(...matchedShortcodesLinks);
        console.log("Added links.");
    } else {
        console.log(`line "${text}"`);
        const skippingEmptyLine = (text.trim() == "");
        const skippingSectionDelimiter = (text == "-------------------");
        const skippingSectionHeader = SECTION_HEADER_REGEXP.test(text);
        const skippingReadingNotesFileHeader = text.startsWith("Reading Notes | ");
        const skippingEvieChapterPrefix = text.startsWith("Chapter:");
        const skippingEvieMyNotesPrefix = text.startsWith("My notes:");

        if (skippingEvieChapterPrefix) {
            console.log("  :: entered evie state");
            assumeEvie = true;
        }
        if (skippingReadingNotesFileHeader) {
            console.log("  :: entered boox state");
            assumeBoox = true;
        }
        if (assumeEvie || assumeBoox) {
            if (skippingSectionDelimiter || (assumeEvie && text == "")) {
                console.log("  :: parsed section finished, de-queue");
                var linksInSection = false;
                var searchText = ""; // TODO kill linksInSection by making this an array
                for (const line of textQueue) {
                    const matches = matchIdentifiers(line, allowWithoutBraces);
                    const matchedShortcodesLinks = findShortcodes(matches);
                    console.log("  :: 8000", line);
                    if (matchedShortcodesLinks.length > 0) {
                        console.log("  :: 8100 (added links)");
                        links.push(...matchedShortcodesLinks);
                        linksInSection = true;
                    } else {
                        console.log("  :: 8200 (checking for note)");
                        // TODO meh the double check of startsWith is lame
                        if (line.startsWith("【Note】") || line.startsWith("My notes:")) {
                            // just google the note together with the [Note] delimiter
                            //   so user can easily see that the previously opened links have
                            //   an action of some sort
                            if (line != "My notes:") { // note .trim() has killed the tab
                                console.log("  :: 8250 (yup, got a non-empty note)");
                                links.push(`https://www.google.com/search?q=${line}`)
                            }
                        } else {
                            // not a special notes section, add to the google it text
                            searchText += line;
                        }
                    }
                }
                if (!linksInSection) {
                    // google any non link-y text
                    links.push(`https://www.google.com/search?q=${searchText}`)
                }
                textQueue = [];
            } else if (skippingReadingNotesFileHeader || skippingEmptyLine || skippingSectionHeader || skippingEvieChapterPrefix) {
                console.log("  :: 7000");
            } else {
                textQueue.push(text);
            }
        } else {
            if (skippingReadingNotesFileHeader || skippingSectionDelimiter || skippingEmptyLine || skippingSectionHeader || skippingEvieChapterPrefix || skippingEvieMyNotesPrefix) {
                console.log(`Skipped ${JSON.stringify({skippingReadingNotesFileHeader, skippingSectionDelimiter, skippingEmptyLine, skippingSectionHeader, skippingEvieChapterPrefix, skippingEvieMyNotesPrefix})}.`);
            } else {
                console.log("No added links, googling the text instead.");
                links.push(`https://www.google.com/search?q=${text}`)
            }
        }
        
    }
}

function processLinks() {
    if (assumeEvie) {
        // spaghetti, add a last empty to close the block if in a evie section
        linksElseGoogle(links, "", false);
    }

    console.log("Found links", links);
    for (const link of links) {
        exec(`xdg-open "${link}"`);
        console.log(`Opened "${link}"`);
    }

    // test cases - all but the second should be skipped
    if (false) {
        linksElseGoogle(links, "Reading Notes | <<jeo>>\"wheewhoo anandtech blah\"")
        linksElseGoogle(links, "rts at $999 {P7G} for the 256GB 11-inch model and $1299 {O7m} for the 256GB 13-inch model. Meanwadded links");
        linksElseGoogle(links, "");
        linksElseGoogle(links, "-------------------");
        linksElseGoogle(links, "2024-05-17 16:01Â Â |Â Â Page No.: 9");
    }
}

const arg0 = argv._[0];
if (arg0) {
    console.log(arg0);
    linksElseGoogle(links, arg0, true);
    processLinks();
    process.exit(1)
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', (line) => {
    linksElseGoogle(links, line.trim(), false);
});

// process the links on ctrl-c. tried with ctrl-d but wasn't able to get it
//   working without needing to first manually throw in a newline after 
//   pasting content from chrome... no idea why
process.on('SIGINT', () => { processLinks(); process.exit() });

rl.on('close', () => {
    processLinks();
});

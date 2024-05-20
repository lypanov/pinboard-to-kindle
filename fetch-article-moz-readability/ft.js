// vim: set sw=4 ts=4 sts=4 expandtab:

const fs = require('fs');
const fsAsync = require('fs').promises;
const TurndownService = require('turndown');
const { exec, execFile } = require('child_process');
const domino = require('@mixmark-io/domino');
const { BASE62, base62encode } = require('./base62');
const process = require('process')
const argv = require('minimist')(process.argv.slice(2));
const axios = require('axios');
const { processImage } = require('./cover');
const util = require('util');
const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);
const { makeReadable } = require('./index');
const { getISOWeek, subDays, startOfDay, getYear } = require('date-fns');
const lodash = require('lodash');
const _url = require('url');
const path = require('path');

// needs apt for xelatex to prevent random issues with utf8 chars in latex
//    texlive-xetex
//    texlive-fonts-recommended

function intersperseArray(arr, value) {
    return lodash.flatMap(arr, (item, index) => index < arr.length - 1 ? [item, value] : [item]);
}

// TODO this should use the remark parser, but depends on a switch to ES
function countWordsMarkdown(text) {
    const cleaned =
      text.replaceAll(/\[.*?\]\(.*?\)( \{[a-zA-Z0-9]{3}\})?/g, "")
          .replaceAll(/^\s*\*\s*$/gm, "");
    return cleaned.split(/\s+/).filter(word => word.length > 0).length;
}

async function fileExists(filePath) {
    try {
        await fsAsync.access(filePath);
        return true;
    } catch (err) {
        if (err.code === 'ENOENT') {
            return false;
        } else {
            throw err; // Re-throw the error if it's not a "file not found" error
        }
    }
}

// TODO this is .size specific
async function getFileSize(filePath) {
    try {
        const stats = await fsAsync.stat(filePath);
        return stats.size;
    } catch (err) {
        if (err.code === 'ENOENT') {
            // just return a random file size > 128 when no .size found
            return 4096;
        } else {
            throw err; // Re-throw the error if it's not a "file not found" error
        }
    }
}

function sanitizeToFilename(url) {
    const parsedUrl = _url.parse(url);
    url = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;

    const extensionMatch = url.match(/\.[a-zA-Z]{1,4}$/);
    var extension = extensionMatch ? extensionMatch[0] : "";

    let baseUrl = url;
    if (extension) {
        baseUrl = url.substring(0, url.length - extension.length);
    }

    if (extension == ".md") {
        // remove .md extension in all cases, as it messes up later on
        //   with our horrible .replace on .md's in filenames and ... why keep it?
        extension = "";
    }

    let sanitized = baseUrl.replace(/[^a-z0-9.]/gi, '_')
        .replace(/_+/g, '_')
        .replace(/^https/, "")
        .replace(/^_/, "")
        .replace(/_$/, "")
        .toLowerCase();

    const maxLength = 200 - extension.length;
    sanitized = sanitized.substring(0, maxLength) + extension;

    // console.log(`url: ${url} -> sanitized: ${sanitized}`);
    return sanitized;
}

function imagePathForUrl(url, mediaPath, conversion = true) {
    const localPath = `${mediaPath}/${sanitizeToFilename(url)}`;
    // TODO could this be refactored to use the same magic as the extension discovery?
    const finalPath = (conversion && localPath.endsWith('.webp'))
          ? localPath.replace(/\.webp$/, '.jpg')
          : localPath;
    return finalPath;
}

async function discoverExtension(url, mediaPath, imgDownloadPromises, alreadyExistsCache) {
    try {
        const finalPath = imagePathForUrl(url, mediaPath);
        if (await fileExists(finalPath)) {
            console.log("symlink/file already present for ${finalPath}, assuming image present and done.");
            // look up extension from symlink and mark that also
            //   (maybe imagePathForURL should be doing this?)
            const finalPathWithExtension = `${mediaPath}/${await checkSymlink(finalPath)}`;
            console.log(`\n\n\nDEBUG OMG OMG\nfinalPathWithExtension -> ${finalPathWithExtension}`);
            alreadyExistsCache[finalPathWithExtension] = true;
            alreadyExistsCache[finalPathWithExtension + ".size"] = await getFileSize(finalPathWithExtension);
            // point non-extension version to the new, needed in alreadyExistsCache as we
            //   can't use promises during the image url replacement in pass two
            alreadyExistsCache[finalPath] = finalPathWithExtension;
            alreadyExistsCache[finalPath + ".size"] = await getFileSize(finalPath);
            // TODO handle case when symlink exists but somehow the image is gone?
            return;
        }
        const response = await axios.head(url);
        if (response.headers['content-type']) {
            const contentType = response.headers['content-type'];
            console.log('Content-Type:', contentType);
            var extension;
            if (contentType == "image/png") {
                extension = "png";
            } else if (contentType == "image/jpeg") {
                extension = "jpg";
            } else if (contentType == "image/webp") {
                // TODO handle this somehow by having it still be converted while
                //   having the symlink point to the final location
                wasExtension = "webp";
                extension = "jpg";
            } else {
                console.log("Unsupported content type, skipping.", contentType);
                return;
            }
            // extension found, now re-run download
            console.log("downloading now extension resolved", url, contentType);
            const symlinkDestination = `${path.basename(finalPath)}.${extension}`;
            const symlinkFilename = finalPath;
            await fsAsync.symlink(symlinkDestination, symlinkFilename);
            imgDownloadPromises.push(downloadImage(url, mediaPath, alreadyExistsCache, wasExtension));
        } else if (response.status == 204) {
            console.log(`${response.status} response during extension discovery, skipping.`);
        } else {
            throw new Error(`Content-Type header not found for URL ${url}`);
        }
    } catch (error) {
        if (error.response.status == 404) {
            console.log(`${error.response.status} response during extension discovery, skipping.`);
        } else {
            console.error('Error:', error.message);
            process.exit(1);
        }
    }
}

async function checkSymlink(filePath) {
    try {
        const stats = await fsAsync.lstat(filePath);

        if (stats.isSymbolicLink()) {
            const linkString = await fsAsync.readlink(filePath);
            console.log('Symbolic link points to:', linkString);
            return linkString;
            
        } else {
            console.log(`This file is not a symbolic link: ${filePath}`);
            process.exit(1);
        }
    } catch (error) {
        console.log('Other Error:', error.message);
        process.exit(1);
    }
}

async function downloadImage(url, mediaPath, alreadyExistsCache, wasExtension) {
    console.log(9999);
    var localPath = imagePathForUrl(url, mediaPath, false);
    const localPathPreSymlinkResolve = localPath;
    var localPathNewExtension = undefined;
    var finalPath = imagePathForUrl(url, mediaPath);

    // TODO doesn't support extension discovered heic/webp etc yet, extend
    // console.log("downloading", url, "to", mediaPath, "as", finalPath);
    if (!supportedImageExtension(finalPath) || url.startsWith("https://substackcdn.com/")) {
        // if not supported, assume symlink, else fail horribly in symlink read
        // console.log(`\n\nWOULD OVERRIDE ${localPath} WITH BALH`);
        localPath = mediaPath + "/" + await checkSymlink(localPath);
        console.log(`NOW IT BECAME ${localPath}, but note that wasExtension == ${wasExtension}`);
        if (wasExtension) {
            localPathNewExtension = localPath;
            finalPath = localPathNewExtension; // WTF
            localPath = localPath.replace("png", "webp").replace("jpg", "webp"); // HARDCODED
            console.log(`lp ${localPath} lpne ${localPathNewExtension}`);
        }
    } else {
        console.log("OH FUCK HIT A EXTENSION DISCOVERED HEIC OR WEBP ETC FUCK - update this note is wrong");
    }

    if (await fileExists(finalPath)) {
        // cache both variants... (should we do that?)
        alreadyExistsCache[localPath] = true;
        alreadyExistsCache[localPath + ".size"] = await getFileSize(localPath);
        alreadyExistsCache[localPathPreSymlinkResolve] = true;
        alreadyExistsCache[localPathPreSymlinkResolve + ".size"] = await getFileSize(localPathPreSymlinkResolve);
        // return a promise which will immediately resolve
        return new Promise((resolve, reject) => {
            console.log(`Download ${url} already exists locally.`);
            resolve();
        });
    }

    console.log(`Starting download of ${url}.`);

    const writer = fs.createWriteStream(localPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', async () => {
            if (localPath.endsWith('.webp')) {
                exec(`ffmpeg -i "${localPath}" "${finalPath}"`, (err, stdout, stderr) => {
                    if (err) {
                        console.log(`Failure while running ffmpeg on ${localPath}.`);
                        reject(err);
                    } else {
                        fs.unlinkSync(localPath); // Remove the original .webp file
                        console.log(`Completed download and conversion of ${url} to ${finalPath}.`);
                        resolve();
                    }
                });
            } else {
                // TODONEXT this should also do the symlinky thingy
                // -> await fs.symlink(dest, src);
                console.log(`Completed download of ${url}.`);
                alreadyExistsCache[localPath] = true;
                alreadyExistsCache[localPath + ".size"] = await getFileSize(localPath);
                // TODO check size of the localPath and if > 100kb optimize
                // TODO run cjpeg ALSO if the source image has density 1x1 as
                //   per the output of file as this fucks lualatex up entirely
                resolve();
            }
        });
        // TODO should unlink the file we tried to create (or on the other end? as shit can always happen)
        writer.on('error', reject);
    });
}

function trimToBaseUrl(url) {
    try {
        const parsedUrl = new URL(url);
        return `${parsedUrl.protocol}//${parsedUrl.host}`;
    } catch (e) {
        // If the URL is not valid, return it as is
        return url;
    }
}

// TODO istead of calling this followed by imagePathForUrl couple the two into one api
// prefix with base if needed, fix up # in url
function urlify(url, baseHref) {
    // fix up this moronic shit...
    // '//www.phoronix.net/image.php?id=2024&amp;image=lichee_rv_nano'
    if (url.startsWith("//www.")) { // extend this by removing the www. if also find cases of that
        url = "https:" + url;
    }
    // no clue if this is up to spec but see #'s in the src urls on:
    //   https://blog.gingerbeardman.com/2024/05/10/emoji-history-the-missing-years/
    // we fix it up here... for no better reason than, why not
    url = url.split("#")[0];
    if (!url.startsWith("http")) {
        // console.log(`url ${url} -> ${baseHref} + ${url}`);
        return `${baseHref}${url}`;
    } else {
        // console.log(`url didn't match ${url}. mustn't be local -> ${url}`);
        return url;
    }
}

// use for cases when the user should see the output as the tool is usually quiet
async function passthroughStreams(thingy) {
    const { stdout, stderr } = thingy;
    if (stdout || stderr) {
        // normally no output, but... just in case
        // TODO this doesn't actually show anything in case of error for lualatex !?
        console.log(stdout, stderr);
    }
}

const REGEXP_MARKDOWN_LINK = /\[(.*?)\]\((.+?)\)/s;
const REGEXP_MARKDOWN_IMAGE = /!\[(.*?)\]\((.+?)( ".*?")?\)/s;

// TODO rename everything skipReadability
async function runPassTwo(unique_ids, baseHref, mediaPath, htmlInput, skipReadability, deadDownloads, disableImageDownloads, alreadyExistsCache) {
    console.log(`\n\nRUN PASS TWO ${baseHref} (disable images -> ${disableImageDownloads})=======\n`);
    console.log(JSON.stringify(alreadyExistsCache));

    // console.log(`\n80000\nrunning htn with disableImageDownloads: ${disableImageDownloads}`);
    const turndownServicePass2 = new TurndownService({
        headingStyle: 'atx',
    });
    if (!skipReadability) {
        turndownServicePass2.addRule(
            "table",
            {
                filter: ['table'],
                replacement: (_, i) => {
                    console.log("unique-ids => ", JSON.stringify(unique_ids));
                    // TODO check this against unique_id's in case it was- never saved or somesuch?
                    const uniqueClassName = i.className.split(" ").filter(className => className.startsWith("unique_id_"))[0];
                    if (uniqueClassName) {
                        return `![](./media/element_${uniqueClassName}.png)`;
                    } else {
                        return "_404_ (table)";
                    }
                }
            });
    }

    const originalInlineLinkRule = turndownServicePass2.options.rules.inlineLink;
    turndownServicePass2.addRule('customInlineLink', {
        filter: originalInlineLinkRule.filter,
        replacement: function(content, node, options) {
            const original = originalInlineLinkRule.replacement(content, node, options);
            const parseMarkdownLink = original.match(REGEXP_MARKDOWN_LINK);
            // NOTE to user clipo.js can be used to open copy/pasted sets of shortcuts
            if (parseMarkdownLink) {
                const shortcut = base62encode(parseMarkdownLink[2]);
                return `${original} {${shortcut}}`;
            } else {
                return original;
            }
        }
    });

	const originalImageRule2 = turndownServicePass2.options.rules.image;
	turndownServicePass2.addRule('customImage', {
		filter: originalImageRule2.filter,
		replacement: function(content, node, options) {
			const original = originalImageRule2.replacement(content, node, options);
			console.log("\nORIGINAL => ", original);
			const parseMarkdownLink = original.match(REGEXP_MARKDOWN_IMAGE);
			// at this point everything should have been downloaded, just check the fs cache
			if (parseMarkdownLink) {
				var url = node.getAttribute('src');
				if (parseMarkdownLink[2] != node.getAttribute('src')) {
					console.log(`URL ${parseMarkdownLink[2]} FUCKED UP PASS TWO, replacing with node attribute -> ${url}`);
				}
				// prefix with base as needed
				url = urlify(url, baseHref);
				var finalPath = imagePathForUrl(url, mediaPath);

				// FIXME is this really not needed? currently disable as it's fine with just using
				//       the non symlinked version... as in pandoc doesn't care about the extension
				//       maybe the other place doesn't need it either and we just need to write the
				//       symlink and be done? kind of meh for the .markdown source though... unsure
				//       i really like this... it's meant to be "canonical" source after all
				// TODO this needs to read from the symlink... but can't use await
				//   so it needs another cache-y thang... i guess?
				// console.log("alreadyexistscache => ", JSON.stringify(alreadyExistsCache));

				if (typeof(alreadyExistsCache[finalPath]) == "string") {
					// symlinked, follow it
					finalPath = alreadyExistsCache[finalPath];
				}

				// console.log(JSON.stringify(alreadyExistsCache));
				// console.log("OOOOOOH FUCCCCK\n\n${skipReadability} && ${disableImageDownloads} -> rdoff version");
				if (finalPath in alreadyExistsCache) {
					console.log(`alreadyExistsCache -> true`);
				} else {
					console.log(`alreadyExistsCache -> false`);
				}
				if (disableImageDownloads) {
					// no images in this version at all
					// console.log(17000);
					// return simply the local download version
					return original;
				} else {
					// console.log(`url: ${url} -> finalPath: ${finalPath}`);
					// console.log(10000);
					// TODO deaddownloads is now dead right?
					var dead = deadDownloads.includes(finalPath);
					console.log(`Checking final path ${finalPath} against dead downloads -> ${dead} and alreadyExistsCache ${JSON.stringify(alreadyExistsCache)}`);
					// console.log(deadDownloads);
                    // skip any messed up images, mostly just 1x1 pixel crap, but might also be
                    // ignoring real 0 byte download failures thanks to this alas
                    const tooSmall = finalPath in alreadyExistsCache && alreadyExistsCache[finalPath + ".size"] <= 128;
					if (dead || !(finalPath in alreadyExistsCache) || tooSmall) {
						// early exit
						  console.log(15000, tooSmall, finalPath);
						const reconstructed = `_404_`;
						return reconstructed;
					}
				}
				const pathSegments = finalPath.split('/');
				pathSegments.shift(); // remove the .
				pathSegments.shift(); // remove the date prefix
				pathSegments.unshift('.'); // bring back the .
				let relativeMdPath = pathSegments.join('/');
				const reconstructed = `![${parseMarkdownLink[1]}](${relativeMdPath})`;
				console.log(`Replaced image link with local download.`);
				if (true) { // debug mode
					console.log(`${original}\n  => ${reconstructed}\n`);
				}
				return reconstructed;
			} else {
				console.log(`Weird image link, skipping entirely. FIXME`);
				return original;
			}
		}
	});

	// kill various blocks that readability weirdly leaves in that
	turndownServicePass2.addRule('jeo1', {
		filter: ["script", "style", "metadata"], // metadata is ours
		replacement: function(_, _, _) {
			return "";
		}
	});


	const turnedDown = turndownServicePass2.turndown(htmlInput);

	// match 'a > div > img' turndown output which gets too many newlines and is
	//   unreadable by pandoc (very frequently seen on substack pages)
	// const matchBrokenImgs = /\[\n\n!\[(.*?)]\((.+?)\)\n\n\]\((.+?)\)(   \{[0-9a-zA-Z]{3}\})/gs;
	const matchBrokenImgs = /\[\n\n!\[(.*?)\]\((.+?)\)\n\n\]\((.+?)\)/gs;

	//   const finalMarkdown = turnedDown.replaceAll(matchBrokenImgs, '[![]($2)]($3)$4');
	const finalMarkdown = turnedDown.replaceAll(matchBrokenImgs, '![]($2)');

	return finalMarkdown;
}

function supportedImageExtension(finalPath) {
	// TODO consider adding consider for gifs
	return finalPath.endsWith(".jpg") || finalPath.endsWith(".jpeg") || finalPath.endsWith(".png") || finalPath.endsWith(".webp");
}

async function runPassOne(mediaPath, htmlInput, disableImageDownloads, alreadyExistsCache) {
    const turndownService = new TurndownService({
        headingStyle: 'atx',
    });
    turndownService.keep("table");

    var baseHref = "";
    turndownService.addRule('captureBaseHref', {
        filter: ["base"],
        replacement: function(a, node, c) {
            baseHref = trimToBaseUrl(node.getAttribute('href'));
            console.log(`Captured base ${baseHref}.`);
            return "";
        }
    });

    var metadata = "";
    turndownService.addRule('captureMetadata', {
        filter: ["metadata"], // could this come from something other than ourselves?
        replacement: function(content, _, _) {
            var unquoted = content.replace('\\[', "[").replace('\\]', "]");
            metadata = JSON.parse(unquoted);
            console.log(`Captured metadata: ${unquoted}.`);
            return "";
        }
    });

    const imgDownloadPromises = [];
    var deadDownloads = []; 
    const extensionDiscoveryPromises = [];

    const originalImageRule = turndownService.options.rules.image;
    var downloading = [];
    turndownService.addRule('preDownloadReferencedImages', {
        filter: originalImageRule.filter,
        replacement: function(content, node, options) {
            const original = originalImageRule.replacement(content, node, options);
            const parseMarkdownLink = original.match(REGEXP_MARKDOWN_IMAGE);
            if (parseMarkdownLink && !disableImageDownloads) {
                // use href from the node directly as ()'s in the URL do not get quoted
                //   and our markdown parser fails to pull them out (feels like bug in turndown)
                var url = node.getAttribute('src');
                if (parseMarkdownLink[2] != node.getAttribute('src')) {
                    console.log(`URL ${parseMarkdownLink[2]} FUCKED UP, replacing with node attribute -> ${url}`);
                }
                // prefix with base as needed
                url = urlify(url, baseHref);
                const finalPath = imagePathForUrl(url, mediaPath);
                console.log("6000", url, baseHref, finalPath)
                var substackCDN = url.startsWith("https://substackcdn.com");
                // anything from substackcdn should have discovery forced as they have .jpg URLS that are being transcoded
                //    yes, this is really lame, and we should instead transition to deciding what to do with a URL
                //    based on the *actually* downloaded content type (TODO)
                if (supportedImageExtension(finalPath) && !substackCDN) {
                    if (downloading.includes(finalPath)) {
                        console.log(`Already downloading ${url} to ${finalPath}. Skipping to prevent race conditions.`);
                    } else {
                        imgDownloadPromises.push(downloadImage(url, mediaPath, alreadyExistsCache));
                        downloading.push(finalPath);
                    }
                } else {
                    console.log("STARTING EXTENSION DISCOVERY FOR ", url);
                    extensionDiscoveryPromises.push(discoverExtension(url, mediaPath, imgDownloadPromises, alreadyExistsCache));
                }
            }
            if (!parseMarkdownLink && !disableImageDownloads) {
                console.log("COULDN'T PARSE MARKDOWN: ", original);
            }
            return original;
        }
    });

    const markdownWithTables = turndownService.turndown(htmlInput);

    const tableElements = markdownWithTables.match(/<table.*?>.*?<\/table>/g) || [];

    var unique_ids = [];

    for (const table of tableElements) {
        const document = domino.createDocument(table);
        const targetTable = document.querySelector('table');
        const uniqueClassName = targetTable.className.split(" ").filter(className => className.startsWith("unique_id_"))[0];
        unique_ids.push(uniqueClassName);
    }

    console.log("awaiting ext promises");
    try {
        await Promise.all(extensionDiscoveryPromises);
    } catch (blah) {
        console.log("8999", blah);
        // ignore as anyway we check the fs
    }
    console.log("Images have finished their downloads and conversions.");

    console.log("awaiting all");
    try {
        await Promise.all(imgDownloadPromises);
    } catch (blah) {
        console.log("8999", blah);
        // ignore as anyway we check the fs
    }
    console.log("Images have finished their downloads and conversions.");

    // TODO console.log(`basehref pssed back as ${baseHref}`);
    return [unique_ids, baseHref, [], metadata, deadDownloads];
}

function getLastSundayISOWeekNumber() {
    const today = new Date();
    const dayOfWeek = today.getDay();

    // If today is not Sunday, adjust the date to the most recent Sunday
    const lastSunday = dayOfWeek === 0 ? startOfDay(today) : subDays(today, dayOfWeek);

    return getISOWeek(lastSunday);
}

// TODO rename urls
async function main(urls, collection, readabilityDisabled, ignoreExistingFiles, firefoxProfile, settings) {
    const week = getLastSundayISOWeekNumber();
    const year = getYear(new Date());
    const dateI = `${year}^${week}`;
    var bookName = `${dateI}-${collection}`;

    // note, recursive like mkdir -p skips on existance
    const basePath = `./${dateI}`;
    fs.mkdirSync(basePath, { recursive: true });
    const mediaPath = `${basePath}/media`;
    fs.mkdirSync(mediaPath, { recursive: true });
    const cachePath = `${basePath}/cache`;
    fs.mkdirSync(cachePath, { recursive: true });
    const resourcePath = `${basePath}/pandoc_resources`;
    fs.mkdirSync(resourcePath, { recursive: true });
    // TODO kinda shitty name
    const srcPath = __dirname;

    // prevent overwriting an existing already generated .epub
    const epubFinalPath = `${basePath}/${bookName}.epub`;
    if (!ignoreExistingFiles && await fileExists(epubFinalPath)) {
        console.log(`Refusing to overwrite existing file ${epubFinalPath.replace("./", "")}.\nPass --force to override.`);
        process.exit(1)
    }

    // TODO add more covers and base the choice on a hash of the raindrop collection name
    await processImage(`${srcPath}/covers/cover-1.jpg`, `${mediaPath}/cover-new.jpg`, [`${year} ^${week}`, collection]);
    passthroughStreams(await execPromise(`cjpeg -baseline -quality 25 -optimize -outfile ${mediaPath}/cover-comp.jpg ${mediaPath}/cover-new.jpg`));

    var headerTex = `\\usepackage{graphicx}
\\usepackage{atbegshi}
\\AtBeginDocument{
  \\newgeometry{left=0cm, right=0cm, top=0cm, bottom=0cm}
  \\makebox[\\textwidth][c]{\\includegraphics[width=\\pagewidth,height=\\pageheight,clip]{./media/cover-comp.jpg}}
  \\restoregeometry
}
`;
    fs.writeFileSync(`${resourcePath}/header.tex`, headerTex);

    var stylesCss = `
        img.emoji-font {
            width: 1em;
            height: 1em;
        }
    `;
    fs.writeFileSync(`${resourcePath}/styles.css`, stylesCss);

    var firstArticle = true;
    var indexFiles = [];
    var indexFilesEmoji = [];

    var toMarker = [];

    var imgDownloadPromises = [];
    var metadatas = {};
    for (const bookmark of urls) {
        var url = bookmark.link;
        var htmlFname = `${cachePath}/${sanitizeToFilename(url)}.html`;
        var htmlRdOffFname = `${cachePath}/${sanitizeToFilename(url)}.rdoff.html`;

        // TODO figure out why the error is the result...
        if (!await fileExists(htmlFname)) {
            try {
                await util.promisify(makeReadable)(url, mediaPath, false, firefoxProfile);
            } catch (blah) {
                // FIXME this is dreadful...
                const [resJoined, rdOffContentJoined] = blah;
                fs.writeFileSync(htmlFname, resJoined);
                fs.writeFileSync(htmlRdOffFname, rdOffContentJoined);
            }
        }

        // read back from the cache
        var htmlInput = fs.readFileSync(htmlFname, 'utf8');
        const htmlRdOffInput = fs.readFileSync(htmlRdOffFname, 'utf8');
        if (readabilityDisabled) {
            // replace the html with the rdoff version
            htmlInput = htmlRdOffInput;
        }

        var alreadyExistsCache = {};

        console.log(JSON.stringify(alreadyExistsCache));
        const [unique_ids, baseHref, _imgDownloadPromises, metadata, deadDownloads] = await runPassOne(mediaPath, htmlInput, false, alreadyExistsCache);
        metadatas[url] = metadata;
        imgDownloadPromises = imgDownloadPromises.concat(_imgDownloadPromises);
        console.log(JSON.stringify(alreadyExistsCache));
        // disable image downloads for rdoff unless readability is disabled
        const disableImageDownloads = !readabilityDisabled;
        var markdownWithImages = await runPassTwo(unique_ids, baseHref, mediaPath, htmlInput, readabilityDisabled, deadDownloads, false, alreadyExistsCache);

        // doesn't include the base, as it's appended to indexFiles
        var mdFname = `${sanitizeToFilename(url)}.md`;
        fs.writeFileSync(`${basePath}/${mdFname}`, markdownWithImages);
        if (!firstArticle) {
            // TODO figure out exactly why this is needed for pdf and seemingly not for epub?
            indexFiles.push(`${srcPath}/newpage.tex`);
            indexFilesEmoji.push(`${srcPath}/newpage.tex`);
        }
        const marked = mdFname.replace(".md", ".marked.md");
        const markedEmoji = mdFname.replace(".md", ".marked.emoji.md");
        toMarker.push(mdFname);
        // TODO rework this so that we insert the newpage's rather
        //   than keeping two arrays - use intersperseArray
        indexFiles.push(marked);
        indexFilesEmoji.push(markedEmoji);
        firstArticle = false;

        const [unique_ids2, baseHref2, _imgDownloadPromises2, metadata2, deadDownloads2] = await runPassOne(mediaPath, htmlRdOffInput, disableImageDownloads, alreadyExistsCache);
        const markdownWithImages2 = await runPassTwo(unique_ids2, baseHref2, mediaPath, htmlRdOffInput, readabilityDisabled, deadDownloads2, disableImageDownloads, alreadyExistsCache);
        var mdFnameRdOff = `${sanitizeToFilename(url)}.rdoff.md`;
        fs.writeFileSync(`${basePath}/${mdFnameRdOff}`, markdownWithImages2);
    }

    const baseCwdedExecOptions = { shell: true, cwd: basePath };

    // all markdown files are ready, run progress_markers.mjs,
    //   we should integrate this rather than shelling out as soon as
    //   we've migrate to ESM.
    const rdOffArgs = readabilityDisabled ? [
        '--rdoff', 'true'
    ] : [];

    const nodeProgressMarkerArgsNonEmoji = [
        `${srcPath}/progress_markers.mjs`,
        ...rdOffArgs,
        ...toMarker
    ];
    // TODO run this only when -m is provided to rd-test.js
    passthroughStreams(await execFilePromise('node', nodeProgressMarkerArgsNonEmoji,
                                             baseCwdedExecOptions ));
    console.log("Progress markers added.");


    // TODO ARGHHHHH !@#@$@!# time constraints yay
    const nodeProgressMarkerArgsEmoji = [
        `${srcPath}/progress_markers.mjs`,
        "--emojis", "true",
        ...rdOffArgs,
        ...toMarker
    ];
    // TODO run this only when -m is provided to rd-test.js
    passthroughStreams(await execFilePromise('node', nodeProgressMarkerArgsEmoji,
                                             baseCwdedExecOptions ));
    console.log("Progress markers [with EPUB emoji's] added.");

    for (var [url, metadata] of Object.entries(metadatas)) {
        const wordCount = Number((metadata[2] || metadata[1] || metadata[0]).replace(" words", ""));
        var mdNoReadableFname = `${basePath}/${sanitizeToFilename(url)}.rdoff.md`;
        const contents = await fs.promises.readFile(mdNoReadableFname, 'utf8');
        const ourWordCount = countWordsMarkdown(contents);
        const ratio = ourWordCount / wordCount;
        // we only display disparity warnings for newyorker, even though there
        //   are obviously more sites, because many newyorker is the only one
        //   that doesn't require much more complex (readability like) heuristics
        const ignoreDisparity = !url.includes("www.newyorker.com/");
        // TODO this ratio can change once we've fixed our [] bug
        if (wordCount > 500 && ratio > 2 && !readabilityDisabled && !ignoreDisparity) {
            console.log(`ERROR: Extremely likely Readability should be disabled for URL: ${url}\nLarge word count disparity between readability output: ${wordCount} and raw source word count estimate: ${ourWordCount} (ratio: ${ratio})`);
            process.exit(1);
        }
        console.log("settings", JSON.stringify(settings));
        if (wordCount >= 3000 && urls.length > 1 && !settings.ignoreLongArticles) {
            console.log(`Very long article found (${wordCount} words) with URL: ${url}.\nPlease re-run it as a single-article book (-s URL -p title)`);
            process.exit(1);
        }
    }
    console.log("Word counts checked and limits verified.");

    // when 3 or more articles no longer provide an 2-level table of content
    const tocDepth = urls.length >= 3 ? 1 : 2;
    const tocDepthArg = `--toc-depth=${tocDepth}`;

    const pandocEpubArgs = [
        '--metadata', `"title=${bookName}"`,
        '--epub-cover-image', `./media/cover-comp.jpg`,
        '--epub-title-page=false',
        '--css=./pandoc_resources/styles.css',
        '-o', `${bookName}.epub`,
        '--toc', tocDepthArg,
        `${srcPath}/settings.md`,
        ...indexFilesEmoji,
    ];
    // change the pandoc cwd as pandoc doesn't really handle --resource-path
    //   (see https://github.com/jgm/pandoc/issues/1450)
    passthroughStreams(await execFilePromise('pandoc', pandocEpubArgs,
                                             baseCwdedExecOptions));
    console.log("EPUB generation completed.");

    const texFname = `${bookName}_1up.tex`;
    const pandocTexArgs = [
        '--pdf-engine=lualatex', '-o', texFname,
        `--include-in-header=./pandoc_resources/header.tex`,
        '--toc', tocDepthArg,
        `${srcPath}/settings.md`,
        ...indexFiles,
    ];
    passthroughStreams(await execFilePromise('pandoc', pandocTexArgs,
                                             baseCwdedExecOptions));
    console.log("TeX generation completed.");

    const fixedTexFname = texFname.replace(".tex", ".fixed.tex");
    const tex = await fs.promises.readFile(`${basePath}/${texFname}`, 'utf8');
    const fixedTex = tex.replace("\\setmainfont[]{Deja Vu Sans}", `
      \\directlua{luaotfload.add_fallback
          ("emojifallback",
          {
          "NotoColorEmoji:mode=harf;"
          }
          )}
      \\setmainfont{Deja Vu Sans}[
          Extension      = .ttf ,
          RawFeature={fallback=emojifallback}
          ]
    `);
    fs.writeFileSync(`${basePath}/${fixedTexFname}`, fixedTex);

    try {
        passthroughStreams(await execFilePromise('lualatex', ["--halt-on-error", "--interaction=batchmode", `${bookName}_1up.fixed.tex`],
                                                 baseCwdedExecOptions));
    } catch (err) {
        passthroughStreams(await execFilePromise('cat', [`${bookName}_1up.fixed.log`],
                                                 baseCwdedExecOptions));
        console.log(`Fatal error during processing of ${bookName}_1up.fixed.tex`);
        console.log(`Fou might have fucked pictures. Try seeing if you have any 0 byte files in: ls -la ~/hardcopy/${basePath}/media/*.jpg; Try exiftool -jfif:Xresolution=72 -jfif:Yresolution=72 on anything shown when you run: file ~/hardcopy/${basePath}/media/*.jpg | grep "DPI" | grep "density 1x1"`);

        process.exit(1);
    }
    // TODO should display texput.log on failure
    console.log("PDF generation completed.");

    // TODO use bookmark.title + bookmark.domain to and generate
    //      many tiny individual PDFs with nice filenames as well
    //      as the existing "indexed" version.

    // now we have the normal version of the pdf, 2up it and store it in the
    //   actual file the user will be using
    const pdfjamArgs = [
        '-q', '--nup', '2x1', '--landscape',
        '--outfile', `${basePath}/${bookName}.pdf`,
        `${basePath}/${bookName}_1up.fixed.pdf`
    ];
    passthroughStreams(await execFilePromise('pdfjam', pdfjamArgs, { shell: true }));
    console.log("PDF 2-up step completed.");
    fs.unlinkSync(`${basePath}/${bookName}_1up.fixed.pdf`);

    passthroughStreams(await execPromise(`rclone copy --immutable -v ${basePath}/${bookName}.epub 'koofr:Boox Sync'`));
}

module.exports = {
    main
};

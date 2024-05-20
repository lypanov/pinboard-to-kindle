// vim: set sw=4 ts=4 sts=4 expandtab:

const { writeFile, writeFileSync } = require('fs');
const { Builder, Capabilities, By } = require('selenium-webdriver');
const crypto = require("crypto");
const firefox = require('selenium-webdriver/firefox');
const { Readability } = require("@mozilla/readability");
const JSDOM = require('jsdom').JSDOM;
const URL = require('url').URL;
const argv = require('minimist')(process.argv.slice(2));

const MULTIPAGE_DOMAIN_LIST = [
    'arstechnica.com'
]

function url_in_blacklist(url, blacklist) {
    let parsed_url = new URL(url);
    let hostname = parsed_url.hostname.toLowerCase();
    for (const blacklisted_domain of blacklist) {
        if (hostname.endsWith(blacklisted_domain.toLowerCase())) {
            return true;
        }
    }
    return false;
}

function is_multipage(url) {
    return url_in_blacklist(url, MULTIPAGE_DOMAIN_LIST);
}

let ADD_UNIQUE_ID_SCRIPT = `
    let uniqueId = 1;
    function addUniqueId(node) {
    if (node.nodeType === 1) { // ELEMENT_NODE
        node.classList.add('unique_id_' + uniqueId);
        uniqueId++;
    }
    node.childNodes.forEach(child => addUniqueId(child));
    }
    addUniqueId(document.body);`;

async function fetch_page_source_firefox(urls, mediaPath, readabilityDisabled, firefoxProfile, callback) {
    const driver = await new Builder()
          .forBrowser('firefox')
          .withCapabilities(Capabilities.firefox().set("acceptInsecureCerts", true))

          .setFirefoxOptions(new firefox.Options().addArguments("-headless", "-profile", firefoxProfile)
                                                  .setBinary("/usr/bin/firefox-esr"))
          .build();
    try {
        // this for the readability version (unless it's disabled)
        var content = "";
        // we keep a non-readability copy to verify readability didn't go AWOL
        var rdOffContent = "";
        var article; // keep the last one for caller to use for metadata

        for (const url of urls) {
            await driver.get(url);
            // alas readyState can't be used for lazy loads
            await driver.wait(async () => {
                const readyState =
                  await driver.executeScript('return document.readyState');
                return readyState === 'complete';
            }, 5000);

            // force loading of lazy-loaded images
            //   (test case: https://www.hackster.io/news/mini-tower-of-power-368118cbffc3)
            // this might also remove the need for page-by-page navigation with arstechnica
            let attempts = 0;
            let lastBottom = 0;

            // rename pageHeight
            const windowInnerHeight = await driver.executeScript('return window.innerHeight');
            while (attempts < 100) {
                // scroll down one page / window worth
                await driver.executeScript(`window.scrollBy(0, ${windowInnerHeight});`);
                // pause for a second to give the page a bit of time, wee bit o' jitter
                await new Promise(r => setTimeout(r, 25 + Math.random() * 10));

                // note: don't cache height, it can change as lazy loaded content is brought in
                const newHeight = await driver.executeScript('return document.body.scrollHeight');
                const scrollTop = await driver.executeScript('return window.scrollY');
                const scrollBottom = scrollTop + windowInnerHeight;
                // stop scrolling when reached bottom
                //   or position hasn't changed since last attempt to scroll
                if (scrollBottom >= newHeight || scrollBottom == lastBottom) {
                    break;
                }
                lastBottom = scrollBottom;
                attempts++;
            }

            // give possible last minute lazy loads a chance
            await driver.sleep(250); 

            // some sites are weird...
            if (url.startsWith("https://obsolescenceguaranteed.blogspot.com/")) {
                await driver.sleep(2000);
            }

            // add unique_id's everywhere so we can map readable tables -> document elements
            await driver.executeScript(ADD_UNIQUE_ID_SCRIPT);

            const page_source = await driver.getPageSource();

            const dom = new JSDOM(page_source);
            var options = { debug: true };
            let reader = new Readability(dom.window.document, options);
            article = reader.parse();
            // FIXME word count can be VERY wrong when readability is cutting off parts of the article
            let articleHtml = (readabilityDisabled || !article) ? page_source : article.content;

            // readability changes it's parsing behaviour for follow on pages
            //   so at least in the case of arstechnica we get some duplicate
            //   and quite useless headers, it might be an idea to look into fixing
            //   this someday. maybe just deleting all but the last h2 when
            //   there is no content between would do the trick?
            
            // also, we should really normalize header levels, anandtech
            //   for example has only h3's no h2's, we should automatically
            //   reduce the top level in the document down / up to be h2
            content += articleHtml;
            rdOffContent += page_source;
            console.log(`Added ${articleHtml.length}. Now totalling ${content.length}`);

            if (!readabilityDisabled) {
                // NOTE this is for ensuring complex tables are rendered by firefox
                //   rather than pandoc / the eink reader. example page: https://www.anandtech.com/show/21387/apple-announces-m4-soc-latest-and-greatest-starts-on-ipad-pro
                //   need to find more examples of this, and consider doing it when
                //   readability fails to resolve figure/img/srcset's, and feasibly
                //   to get syntax highlighting on code blocks... but unsure it'll
                //   look decent on the boox screen so delaying this for now as
                //   pre/code blocks seem to be easily good enough at the moment

                const readableDom = new JSDOM(articleHtml);
                const readableDocument = readableDom.window.document;
                const tables = readableDocument.querySelectorAll('table');

                for (const table of tables) {
                    console.log(table.className);
                    const uniqueClassName = table.className.split(" ").filter(className => className.startsWith("unique_id_"))[0];
                    if (!uniqueClassName) {
                        continue;
                    }

                    console.log('Class name of the table:', uniqueClassName);

                    let element = await driver.findElement(By.className(uniqueClassName));
                    await driver.executeScript("arguments[0].scrollIntoView({behavior: 'auto', block: 'center', inline: 'center'});", element);
                    await driver.sleep(250); // give possible lazy loads a chance
                    const elementScreenshot = await element.takeScreenshot();
                    writeFileSync(`./${mediaPath}/element_${uniqueClassName}.png`, elementScreenshot, 'base64');
                    console.log(`Screenshot element_${uniqueClassName} saved.`);
                }
            }
        }
        return callback(article, content, rdOffContent);
    } catch (blah) {
        console.log("well fuck", blah, urls);
    } finally {
        await driver.quit();
    }
}

async function fetch_page_source_jsdom_arstechnica(url) {
    var dom = await JSDOM.fromURL(url);
    var urls = [url];
    for (const x of dom.window.document.querySelectorAll("nav.page-numbers a:not(:last-child)")) {
        if (x.href == dom.window.location.href) {
            console.log(`Already added ${x.value}.`)
        } else {
            var _url = x.href;
            console.log(`Adding newly found URL ${_url}.`);
            var _dom = await JSDOM.fromURL(_url);
            urls.push(_url);
        }
    }
    return urls;
}

// TODO find more examples and make this generic and kill the duplication
async function fetch_page_source_jsdom_anandtech(url) {
    var dom = await JSDOM.fromURL(url);
    var urls = [url];
    for (const x of dom.window.document.querySelectorAll("div.article_links_top option")) {
        if (x.value == dom.window.location.pathname) {
            console.log(`Already added ${x.value}.`)
        } else {
            var _url = dom.window.location.origin + x.value;
            console.log(`Adding newly found URL ${_url}.`);
            var _dom = await JSDOM.fromURL(_url);
            urls.push(_url);
        }
    }
    return urls;
}

async function makeReadable(url, mediaPath, readabilityDisabled, firefoxProfile, callback) {
    // TODO for now i'm no longer reading anandtech so hardcoding the arstechnica
    //      resolver, though left anandtech around to show another example so we
    //      don't over-fit the code to arstechnica when making it more generic.
    let url_lister_thingy = fetch_page_source_jsdom_arstechnica;
    var urls;
    if (is_multipage(url)) {
        urls = await url_lister_thingy(url);
    } else {
        urls = [url];
    }
    fetch_page_source_firefox(urls, mediaPath, readabilityDisabled, firefoxProfile, (article, jeo, rdOffContent) => {
        let articleHtml = jeo; // TODO rename -> content?

        if (!article) {
            article = { byline: "" };
        }

        // Meta data (sub title, site name, word count)
        let meta = [];
        if (article.byline) {
            meta.push(article.byline);	
        }
        if (article.siteName && article.byline != article.siteName) {
            meta.push(article.siteName);
        }
        const wordCount = article.textContent.trim().split(/\s+/).length;
        meta.push(wordCount + ' words');	

        let res1 = [];
        let res2 = [];

        // Base path for images and other media
        res1.push('<base href="' + url + '" />')

        if (article.title) {
            res1.push('<h1 class="pb-to-kindle-article-title">' + article.title + '</h1>');
        }
        res1.push('<p><i class="pb-to-kindle-article-metadata">' + meta.join(' • ') + '</i></p>');

        // used to transport the metadata back across the boundary
        //   without needing to create a metadata caching layer
        res1.push('<metadata>' + JSON.stringify(meta) + '</metadata>');

        res1.push('<hr>');
        // article comes next
        res2.push('<hr>');

        // Article links
        let links = [];
        links.push('<a class="pb-to-kindle-article-link" href="' + url + '">Article link</a>');

        res2.push('<p><i>' + links.join(' • ') + '</i></p>');

        var resJoined = res1.join("\n") + articleHtml + res2.join("\n");
        var rdOffResJoined = res1.join("\n") + rdOffContent + res2.join("\n");

        // TODO how does this become an error?
        return callback([resJoined, rdOffResJoined]); 
    });
}

module.exports = {
    makeReadable
};

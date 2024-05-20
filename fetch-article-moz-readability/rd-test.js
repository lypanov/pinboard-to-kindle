const process = require("process");
const axios = require('axios');
const { main } = require('./ft');
const minimist = require('minimist');
const os = require("os");

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});

class RaindropClient {
    constructor(token) {
        this.token = token;
    }

    _getAxiosConfig(method = 'GET', data = null) {
        const config = {
            method: method,
            headers: {
                'Authorization': `Bearer ${this.token}`
            },
            data: data
        };
        return config;
    }

    async getCollectionIdByName(collectionName) {
        const response = await axios('https://api.raindrop.io/rest/v1/collections', this._getAxiosConfig());
        const collection = response.data.items.find(item => item.title === collectionName);
        if (!collection) {
            throw new Error(`Collection '${collectionName}' not found.`);
        }
        return collection._id;
    }

    // returns bookmarks in given collection in reverse manual order (as in, last first), pages as needed
    async getBookmarksInCollection(collectionId) {
        let bookmarks = [];
        let page = 0;
        let possiblyContinues = true;

        while (possiblyContinues) {
            const response = await axios.get(`https://api.raindrop.io/rest/v1/raindrops/${collectionId}`, {
                ...this._getAxiosConfig(),
                params: {
                    perpage: 50,
                    sort: "created",
                    page: page
                }
            });

            const items = response.data.items;
            bookmarks = bookmarks.concat(items);

            possiblyContinues = items.length === 50;
            page += 1;
        }

        return bookmarks; // FIXME bring back reversing by adding a sort="created" param
    }

    async moveBookmarksToCollection(bookmark, targetCollectionId) {
        await axios(`https://api.raindrop.io/rest/v1/raindrop/${bookmark._id}`, this._getAxiosConfig('PUT', { collectionId: targetCollectionId }));
    }

    async setNoteForBookmark(bookmark, note) {
        await axios(`https://api.raindrop.io/rest/v1/raindrop/${bookmark._id}`, this._getAxiosConfig('PUT', { note: note }));
    }

    createBookmarkHash(bookmark) {
        const { link, domain, title } = bookmark;
        return { link, domain, title };
    }
}

const MINIMIST_CONFIGURATION = {
    string: ['postfix-override', 'single-url'],
    boolean: ['use-raw-html', 'ignore-long-articles', 'keep', 'help', 'force'],
    alias: {
        p: 'postfix-override',
        s: 'single-url',
        r: 'use-raw-html',
        l: 'ignore-long-articles',
        k: 'keep',
        h: 'help',
        f: 'force' // TODO no docs
    },
    default: {
        'postfix-override': ''
    }
};

function displayHelp() {
    console.log(`
Usage: node rd-test.js [collection] [options]

The command requires the following environment variable to be set:
  RAINDROP_TOKEN          Set this to a Test token generated in Raindrop -> Integrations.
  HARDCOPY_FIREFOX_PROFILE  ...

Positional arguments:
  collection              The name of the collection (default: 'Articles').

Options:
  -p, --postfix-override  Override the book name (defaults to collection name).
  -s, --single-url        Ignore all articles other than the provided article in the collection, mostly useful when coupled with the large article detection.
  -r, --use-raw-html      Skip running Readability over the URLs.
  -l, --ignore-long-articles ...
  -k, --keep              Skip the archival step, useful for trying out the tool.
  -h, --help              Display this help message.
`);
}

(async () => {
    try {
        const raindropToken = process.env.RAINDROP_TOKEN;
        const firefoxProfile = process.env.HARDCOPY_FIREFOX_PROFILE;

        const args = minimist(process.argv.slice(2), MINIMIST_CONFIGURATION);
        if (args.help || !raindropToken || !firefoxProfile) {
            displayHelp();
            process.exit(args.help ? 0 : 1);
        }

        // switch to the ~/hardcopy directory for the rest of the script,
        //   everything takes place relative to this path
        process.chdir(`${os.homedir()}/hardcopy`);

        const client = new RaindropClient(raindropToken);

        const collection = args._[0] || 'Articles';
        const postfixOverride = args["postfix-override"];
        // TODO single url should require -p to avoid mistakes
        const singleUrl = args["single-url"];
        const skipArchival = args.keep;
        const skipReadability = args["use-raw-html"];
        const bookPostfix = postfixOverride ? postfixOverride : collection;
        const ignoreExistingFiles = args.force;

        const collectionId = await client.getCollectionIdByName(collection);
        const archiveCollectionId = await client.getCollectionIdByName('Archived');

        const bookmarks = await client.getBookmarksInCollection(collectionId);
        if (bookmarks.length == 0) {
            throw new Error(`No bookmarks found in '${collection}' collection.`);
        }

        var subsetHashes = bookmarks.map(bookmark => client.createBookmarkHash(bookmark));
        if (singleUrl) {
            subsetHashes = subsetHashes.filter(item => item.link == singleUrl);
            if (subsetHashes.length === 0) {
                throw new Error(`Bookmark ${singleUrl} not found in collection, attempted to create empty book.`);
            }
        }

        var settings = {
            ignoreLongArticles: args["ignore-long-articles"]
        };
        await main(subsetHashes, bookPostfix, skipReadability, ignoreExistingFiles, firefoxProfile, settings);

        for (let bookmark of bookmarks) {
            // We use the note "Archived" to enable bookmarking of:
            //   https://app.raindrop.io/my/0/notag%3Atrue%20note%3AArchived/
            // Which searches for anything Archived but untagged.
            // Downside: this breaks the Notes filter.
            const urlMatchOrSingleUrlDisabled = !singleUrl || singleUrl == bookmark.link;
            if (!skipArchival && urlMatchOrSingleUrlDisabled) {
                // TODO fix this to *append* to the existing note so
                //   we don't loose already added custom notes
                await client.setNoteForBookmark(bookmark, 'Archived');
                await client.moveBookmarksToCollection(bookmark, archiveCollectionId);
            }
        }
        if (!skipArchival) {
            console.log('Bookmarks processed and archived.');
        }
    } catch (error) {
        throw error;
    }
})();

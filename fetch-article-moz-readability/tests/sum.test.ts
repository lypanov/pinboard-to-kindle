// vim: set sw=4 ts=4 sts=4 expandtab:

// sum.test.ts
import { sum } from '../src/sum';
// @ts-ignore
import { main } from '../ft.js';
const fs = require('fs');
const process = require('process');

function countMatches(data: string, searchString: string) {
    let occurrences = 0;
    let position = 0;

    while ((position = data.indexOf(searchString, position)) !== -1) {
        occurrences++;
        position += searchString.length;
    }

    return occurrences;
}

test('adds 1 + 2 to equal 3', async () => {
    var basePath = "2024^29/"; // TODO fix cache directory hardcode
    fs.rmSync(`${basePath}/media`, {force: true, recursive: true});
    fs.mkdirSync(`${basePath}/media`);
    // copy in stub cover to speed up tests
    fs.copyFileSync("./stub-cover-new.jpg", `${basePath}/media/cover-new.jpg`);
    fs.rmSync("/tmp/test-profile", {force: true, recursive: true});
    fs.mkdirSync("/tmp/test-profile");
    await main([{ link: "https://www.goto10retro.com/p/atari-corporation-goes-public-in" }], "Test", false, true, "/tmp/test-profile", {});
    var path = `${basePath}/www.goto10retro.com_p_atari_corporation_goes_public_in.md`;

    const data = fs.readFileSync(path, 'utf8');
    const countBefore = countMatches(data, "_404");

    // RETRY
    await main([{ link: "https://www.goto10retro.com/p/atari-corporation-goes-public-in" }], "Test", false, true, "/tmp/test-profile", {});

    const dataNew = fs.readFileSync(path, 'utf8');
    const countAfter = countMatches(dataNew, "_404");

    expect(countAfter).toBe(0);
    expect(countBefore).toBe(0);
}, 45000);


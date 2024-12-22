import 'dotenv/config';
import Parser from 'rss-parser';
import fs from 'node:fs/promises';
import osPath from 'node:path';
import os from 'node:os';
import RichtextBuilder from '@atcute/bluesky-richtext-builder';

abstract class DatabasePersister {
    abstract restoreDatabase(path: string): Promise<void>;
    abstract persistDatabase(path: string): Promise<void>;
}

let persister: DatabasePersister;
if (process.env.USE_ACTIONS) {
    const { DefaultArtifactClient } = await import('@actions/artifact');
    const { context, getOctokit } = await import('@actions/github');

    const octokit = getOctokit(process.env.GITHUB_TOKEN!);

    persister = new class ReleasesDatabasePersister extends DatabasePersister {
        async restoreDatabase(path: string): Promise<void> {
            let getReleaseResponse;
            try {
                getReleaseResponse = await octokit.rest.repos.listReleases({
                    per_page: 1,
                    // page: 1,
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                });
            } catch (err) {
                console.error(`getReleaseResponse ${err}`);
                return;
            }

            if (getReleaseResponse.status != 200) {
                console.log(`getReleaseResponse status ${getReleaseResponse.status}`);
                return;
            }

            const downloadUrl = getReleaseResponse.data[0].assets.find(e => e.name == osPath.basename(path))?.browser_download_url
            if (!downloadUrl) {
                console.log(`no downloadUrl for ${getReleaseResponse.data[0].name}`);
                return;
            }

            const buf = await fetch(downloadUrl).then(e => e.ok ? e.arrayBuffer() : undefined);
            if (buf) {
                fs.writeFile(path, Buffer.from(buf));
                console.log('downloaded database');
            } else {
                console.log('not ok');
            }
        }

        async persistDatabase(path: string): Promise<void> {
            const date = new Date();

            const createReleaseResponse = await octokit.rest.repos.createRelease({
                owner: context.repo.owner,
                repo: context.repo.repo,
                tag_name: 'database-' + date.toISOString().replace(/:/g, '-'),
                name: `Persisting database at ${date.toUTCString()}`,
                draft: false,
                prerelease: true
            });

            await octokit.request<'POST {origin}/repos/{owner}/{repo}/releases/{release_id}/assets{?name,label}'>({
                method: "POST",
                url: createReleaseResponse.data.upload_url,
                headers: {
                    "content-type": "application/zip",
                    'X-GitHub-Api-Version': '2022-11-28'
                },
                data: await fs.readFile(path),
                name: osPath.basename(path),
                label: osPath.basename(path),
            });
        }
    }
} else {
    persister = new class DummyDatabasePersister extends DatabasePersister {
        async restoreDatabase(path: string): Promise<void> {
        }
        async persistDatabase(path: string): Promise<void> {
        }
    }
}

await persister.restoreDatabase('database.db');

const { db } = await import('./db.js'); // import after the db is restored

import { Bot } from "@skyware/bot";

const bot = new Bot();
await bot.login({
	identifier: process.env.BSKY_USERNAME!,
	password: process.env.BSKY_PASSWORD!,
});

const parser = new Parser<{}, { description?: string, 'media:content'?: { 'media:text'?: string[], 'media:title'?: string[] } }>({
    customFields: {
        item: ['description', 'media:content']
    }
});
let feed = await parser.parseURL(process.env.FEED_URL!);
console.log(feed.title);

const existingGuids = new Set((await db
    .selectFrom('entries')
    .where('guid', 'in', feed.items.filter(e => e.guid).map(e => e.guid) as string[])
    .select('guid')
    .execute()
).map(e => e.guid));

import { exec, spawn, fork, execFile } from 'promisify-child-process';

async function fetchAndCompress(uri: string) {
    const fetched = await fetch(uri);
    if (!fetched.ok) {
        throw new Error(`${fetched.status}: ${fetched.statusText}`);
    }

    const blob = await fetched.blob();
    const buf = await blob.arrayBuffer();
    if (buf.byteLength <= 1000000) // https://github.com/bluesky-social/atproto/blob/09656d6db548d18da88ff580aab70a848613584f/lexicons/app/bsky/embed/images.json#L24C22-L24C29
        return blob;

    const tmpdir = await fs.mkdtemp(osPath.join(os.tmpdir(), 'bsky-image-processor-'));
    await fs.writeFile(osPath.join(tmpdir, 'input.jpg'), Buffer.from(buf));
    const procOutput = process.env.CJPEGLI_PATH
        ? await execFile(process.env.CJPEGLI_PATH, ['-v', '-q', '80', osPath.join(tmpdir, 'input.jpg'), osPath.join(tmpdir, 'output.jpg')])
        : await execFile((await import('mozjpeg')).default, ['-outfile', osPath.join(tmpdir, 'output.jpg'), '-quality', '80', osPath.join(tmpdir, 'input.jpg')]);
    console.log(procOutput.stdout);
    console.error(procOutput.stderr);
    if (procOutput.code != 0) {
        throw new Error(`Exited with code ${procOutput.code}`);
    }

    const newBuf = await fs.readFile(osPath.join(tmpdir, 'output.jpg'));
    await fs.rm(tmpdir, {recursive: true});

    return new Blob([newBuf], {type: 'image/jpeg'});
}

//for (const post of (await bot.getUserPosts(bot.profile.did)).posts) {
//    await post.delete();
//}

for (const item of feed.items.filter(e => e.guid && !existingGuids.has(e.guid))) {
    console.log(`${item.title}: ${item.link}`);

    console.log({
        createdAt: new Date(item.pubDate!),
        // text: new RichtextBuilder()
        //     .addLink((item.title ?? item.link)?.trim()!, item.link?.trim()!)
        //     .build(),
        title: item.title?.trim()!,
        description: item.description?.trim()!,
        uri: item.link?.trim()!,
        thumb: item.enclosure ? {
            data: item.enclosure?.url?.trim(),
            alt: (item['media:content']?.['media:text'] ?? item['media:content']?.['media:title'])?.join('')?.trim()
        } : undefined
    });

    //await bot.post({
    //    createdAt: new Date(item.pubDate!),
    //    text: '',
    //    // text: new RichtextBuilder()
    //    //     .addLink((item.title ?? item.link)?.trim()!, item.link?.trim()!),
    //    external: {
    //        title: item.title?.trim()!,
    //        description: item.description?.trim()!,
    //        uri: item.link?.trim()!,
    //        thumb: item.enclosure ? {
    //            data: await fetchAndCompress(item.enclosure?.url?.trim()!),
    //            alt: (item['media:content']?.['media:text'] ?? item['media:content']?.['media:title'])?.join('')?.trim()
    //        } : undefined
    //    },
    //});

    await db.insertInto('entries').values({ guid: item.guid! }).executeTakeFirstOrThrow();
}

console.log('destroying db');
await db.destroy();
console.log('destroyed db');

await persister.persistDatabase('database.db');
console.log('persisted db');

process.exit(0);
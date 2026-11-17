import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { startServer, type TestServer } from './server';

test.describe.configure({ mode: 'serial' });

/** A 4×3 PNG, as the photos' images. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEklEQVR4nGP4z8AARwzEcQwDAH2gC/UmQhvLAAAAAElFTkSuQmCC',
  'base64',
);

let unsplash: Server;
let server: TestServer;
const asked: string[] = [];

test.beforeAll(async () => {
  test.setTimeout(120_000);
  // Unsplash, as far as the server uses it, with the images it hands out.
  unsplash = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    asked.push(url.pathname);
    const base = `http://127.0.0.1:${(unsplash.address() as AddressInfo).port}`;
    if (url.pathname === '/search/photos') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          results: [
            {
              id: 'arm',
              description: 'A robot arm on a bench',
              alt_description: null,
              urls: { small: `${base}/img/arm-small.png`, regular: '', raw: `${base}/img/arm.png` },
              user: { name: 'Ada Lens', links: { html: `${base}/@ada` } },
              links: { download_location: `${base}/photos/arm/download` },
            },
          ],
        }),
      );
    } else if (url.pathname.startsWith('/img/')) {
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    } else if (url.pathname === '/photos/arm/download') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => unsplash.listen(0, '127.0.0.1', resolve));
  server = await startServer({
    UNSPLASH_ACCESS_KEY: 'test-key',
    UNSPLASH_API_URL: `http://127.0.0.1:${(unsplash.address() as AddressInfo).port}`,
  });
});
test.afterAll(async () => {
  await server?.stop();
  await new Promise((resolve) => unsplash?.close(resolve));
});

test('an Unsplash photo as a cover, credited, through the server', async ({ page }) => {
  page.on('pageerror', (error) => console.error(`[page] ${error.stack ?? error}`));
  await page.goto(server.base);
  await page.getByLabel('Name').fill('Ada');
  await page.getByLabel('Email').fill('ada@lab.io');
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByPlaceholder('New workspace name').fill('Covers');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'New page' }).click();
  await page.getByLabel('Page title').fill('Arm');

  await page.getByRole('button', { name: 'Add cover' }).click();
  await page.getByRole('button', { name: 'Change cover' }).click();
  await page.getByRole('tab', { name: 'Unsplash' }).click();
  const tab = page.getByTestId('unsplash');
  await tab.getByLabel('Search Unsplash').fill('robot arm');
  await tab.getByRole('button', { name: 'A robot arm on a bench' }).click();

  const cover = page.getByTestId('page-cover');
  await expect(cover).toHaveAttribute('data-kind', 'url');
  await expect(cover).toHaveAttribute('style', /img\/arm\.png\?w=2400/);
  await cover.hover();
  await expect(page.getByTestId('cover-credit')).toHaveText('Photo by Ada Lens on Unsplash');
  // The pick was reported to Unsplash, by the server.
  await expect.poll(() => asked.includes('/photos/arm/download')).toBe(true);
});

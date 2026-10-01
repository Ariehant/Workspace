import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { editor, expect, quit, test, waitForIndexed } from './helpers';

/** 4×3 red PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEklEQVR4nGP4z8AARwzEcQwDAH2gC/UmQhvLAAAAAElFTkSuQmCC',
  'base64',
);
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj ' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
);

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/article') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><head><title>fallback</title>
        <meta property="og:title" content="Motor control primer">
        <meta property="og:description" content="PID loops, feed-forward and tuning.">
        </head><body>hi</body></html>`);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}

async function slash(window: Page, query: string) {
  await window.keyboard.type(`/${query}`);
  await expect(window.getByTestId('slash-menu').getByRole('option').first()).toBeVisible();
  await window.keyboard.press('Enter');
}

/** Fire a paste or drop of files at the editor, as the OS would. */
async function sendFiles(
  window: Page,
  kind: 'paste' | 'drop',
  files: { name: string; type: string; base64: string }[],
) {
  await editor(window).evaluate(
    (el, { kind, files }) => {
      const data = new DataTransfer();
      for (const f of files) {
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
        data.items.add(new File([bytes], f.name, { type: f.type }));
      }
      if (kind === 'paste') {
        el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      } else {
        const last = el.lastElementChild!.getBoundingClientRect();
        const init = {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
          clientX: last.left + 10,
          clientY: last.top + 5,
        };
        el.dispatchEvent(new DragEvent('dragover', init));
        el.dispatchEvent(new DragEvent('drop', init));
      }
    },
    { kind, files },
  );
}

async function pasteText(window: Page, text: string) {
  await editor(window).evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

const loaded = (img: ReturnType<Page['locator']>) =>
  img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth);

test('image: upload, caption, resize, and it loads again after a restart', async ({ launch }) => {
  const launched = await launch();
  let { window } = launched;
  await newPage(window, 'Gallery');
  await slash(window, 'image');
  await window.getByTestId('media-placeholder').getByLabel('Upload file').setInputFiles({
    name: 'gripper.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  const img = () => editor(window).locator('.ws-image img');
  await expect(img()).toHaveAttribute('src', /^ws-file:\/\/[0-9a-f]{64}\.png$/);
  await expect.poll(() => loaded(img())).toBe(4);

  await editor(window).getByLabel('Caption').fill('Gripper close-up');
  const figure = editor(window).locator('.ws-image');
  const before = (await figure.boundingBox())!.width;
  await figure.hover();
  const handle = figure.getByRole('separator', { name: 'Resize image from the right' });
  const box = (await handle.boundingBox())!;
  await window.mouse.move(box.x + 2, box.y + box.height / 2);
  await window.mouse.down();
  await window.mouse.move(box.x - 100, box.y + box.height / 2, { steps: 5 });
  await window.mouse.up();
  await expect.poll(async () => (await figure.boundingBox())!.width).toBeLessThan(before - 150);
  const width = Math.round((await figure.boundingBox())!.width);
  await waitForIndexed(window, 'Gripper');

  await quit(launched.app);
  ({ window } = await launch());
  await expect.poll(() => loaded(img())).toBe(4);
  await expect(editor(window).getByLabel('Caption')).toHaveValue('Gripper close-up');
  expect(Math.round((await editor(window).locator('.ws-image').boundingBox())!.width)).toBe(width);
});

test('pasting and dropping files creates image, PDF and file blocks', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Attachments');
  await sendFiles(window, 'paste', [
    { name: 'shot.png', type: 'image/png', base64: PNG.toString('base64') },
  ]);
  await expect(editor(window).locator('.ws-image img')).toHaveAttribute('src', /^ws-file:/);
  // The cursor continues in a new block below the pasted image.
  await window.keyboard.type('After the image');
  await expect(editor(window).locator(':scope > p').last()).toHaveText('After the image');

  await sendFiles(window, 'drop', [
    { name: 'datasheet.pdf', type: 'application/pdf', base64: PDF.toString('base64') },
    {
      name: 'wiring notes.txt',
      type: 'text/plain',
      base64: Buffer.from('red = +12V').toString('base64'),
    },
  ]);
  await expect(editor(window).locator('iframe.ws-pdf')).toHaveAttribute(
    'src',
    /^ws-file:\/\/[0-9a-f]{64}\.pdf$/,
  );
  const file = editor(window).locator('[data-kind="file"]');
  await expect(file).toContainText('wiring notes.txt');
  await expect(file).toContainText('10 B');
  await waitForIndexed(window, 'datasheet');

  // The PDF is served to the renderer by the ws-file protocol.
  const src = await editor(window).locator('iframe.ws-pdf').getAttribute('src');
  const head = await window.evaluate(
    async (url) => (await (await fetch(url!)).text()).slice(0, 8),
    src,
  );
  expect(head).toBe('%PDF-1.4');
});

test('web bookmark fetches a preview card', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Reading list');
  await slash(window, 'bookmark');
  const input = editor(window).getByLabel('Bookmark link');
  await expect(input).toBeFocused();
  await input.fill(`${origin}/article`);
  await input.press('Enter');
  const card = editor(window).getByTestId('bookmark');
  await expect(card).toContainText('Motor control primer');
  await expect(card).toContainText('PID loops, feed-forward and tuning.');
  await expect(card).toHaveAttribute('href', `${origin}/article`);
});

test('pasting a link offers bookmark or embed', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Links');
  await pasteText(window, `${origin}/article`);
  const menu = window.getByTestId('paste-url-menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['URL', 'Bookmark']);
  await menu.getByRole('menuitem', { name: 'Bookmark' }).click();
  await expect(editor(window).getByTestId('bookmark')).toContainText('Motor control primer');

  await editor(window).locator('p').last().click();
  await pasteText(window, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await menu.getByRole('menuitem', { name: 'Embed' }).click();
  await expect(editor(window).locator('.ws-embed iframe')).toHaveAttribute(
    'src',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  );

  // Dismissing keeps a plain link.
  await editor(window).locator('p').last().click();
  await pasteText(window, 'https://example.com/spec');
  await window.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(editor(window).locator('a[href="https://example.com/spec"]')).toHaveText(
    'https://example.com/spec',
  );
});

test('embeds reject unsupported sites and offer a bookmark instead', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Embeds');
  await slash(window, 'embed');
  await editor(window).getByLabel('Embed link').fill(`${origin}/article`);
  await editor(window).getByLabel('Embed link').press('Enter');
  await expect(editor(window)).toContainText("This link can't be embedded");
  await editor(window).getByRole('button', { name: 'Create bookmark' }).click();
  await expect(editor(window).getByTestId('bookmark')).toContainText('Motor control primer');
});

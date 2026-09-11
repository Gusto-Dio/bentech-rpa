import { createLogger } from '@rpa/core';
import { chromium, type Page } from 'playwright';
import { PostSignaturePage } from '../../automations/group-submission/anthem-ca-new-plans/src/pages/post-signature.page.ts';
import type { AutomationConfig } from '../../automations/group-submission/anthem-ca-new-plans/src/config.ts';
import { button, field } from '../../automations/group-submission/_shared/src/lightning.ts';

/**
 * Checks the `Document Checklist` locators against the LIVE screen, read-only.
 *
 * Every assertion below is a read. Nothing is clicked, nothing is uploaded and
 * `Submit` is never pressed - the point is to prove the page object's locators
 * resolve on the real DOM without advancing a filed application.
 *
 * Attach the recon browser to the checklist first:
 *   pnpm tsx tooling/scripts/anthem-serve.ts &
 *   pnpm tsx tooling/scripts/anthem-do.ts "u .../applicationrecordaction?c__ContextId=<appId>&c__isUploadDocument=true"
 */
async function main(): Promise<void> {
  const expectedCompany = process.argv[2] ?? 'The Company LLC';
  const expectedQuote = process.argv[3];

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  try {
    const pages: Page[] = browser.contexts().flatMap((c) => c.pages());
    const page = pages.at(-1);
    if (page === undefined) throw new Error('no page');

    const post = new PostSignaturePage(
      page,
      { logger: createLogger({ level: 'info', pretty: true, base: {} }) },
      { allowSubmit: true, memberEnrollmentType: 'Online Census Tool' } as unknown as AutomationConfig,
    );

    const rows = await post.readChecklist();
    console.log(`readChecklist() -> ${rows.length} rows`);
    for (const row of rows) {
      console.log(
        `  ${row.required ? 'REQ' : '   '}  ${row.name.padEnd(40)} ${row.status.padEnd(15)} ${row.fileName}`,
      );
    }

    /**
     * Only present on the STANDALONE checklist. In-wizard the evidence dump
     * reads `fields: []`, which is exactly how the postcondition that read it
     * failed on a screen it had reached correctly - so it is reported here as a
     * difference between the two entry points, not asserted.
     */
    const applicationName = await field(page, 'Application Name').first().inputValue().catch(() => '');
    console.log(`\nApplication Name field  : ${applicationName === '' ? '(absent - in-wizard shape)' : `"${applicationName}"`}`);
    if (applicationName !== '') {
      console.log(`  contains "${expectedCompany}" : ${applicationName.toLowerCase().includes(expectedCompany.toLowerCase())}`);
    }

    if (expectedQuote !== undefined) {
      // The exact expression reachDocumentChecklist's postcondition uses.
      const matched = rows.some((row) => row.fileName.includes(expectedQuote));
      console.log(`\nrows.some(fileName.includes("${expectedQuote}")) : ${matched}   <- the postcondition`);
    }

    console.log(`\nbutton(page, 'Submit')      : ${await button(page, 'Submit').count()} match(es)`);
    console.log(`getByRole button "Submit"   : ${await page.getByRole('button', { name: 'Submit', exact: true }).count()} match(es)  <- the trap`);
    console.log(`input.hidden-file-input     : ${await page.locator('input.hidden-file-input').count()} match(es)`);
    console.log(`required rows in the table  : ${rows.filter((r) => r.required).length}`);
    console.log(`outstanding required        : ${rows.filter((r) => r.required && r.fileName === '').map((r) => r.name).join(', ') || '(none)'}`);
  } finally {
    // Disconnect, never close: this browser is the reconnaissance session.
    await browser.close();
  }
}

await main();

The `asana`, `jira` and `monday` fixtures are small, made-up exports written to the columns
Asana's and Jira's CSV and monday.com's Excel exports use (as documented, from memory: no real
export was available when they were written). The importers keep any column they don't know as
text, so a column named a little differently isn't lost.

`monday/Arm_build.xlsx` is written by `mondayBoard()` in `src/xlsx-fixture.ts` (a test checks
the two match): change the board there, then write the file again with

```sh
node --experimental-strip-types -e "import('./src/xlsx-fixture.ts').then(m => require('fs').writeFileSync('fixtures/monday/Arm_build.xlsx', m.mondayBoard()))"
```

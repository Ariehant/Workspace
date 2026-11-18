# Word fixtures

Real `.docx` files, made from `source.md` (with `arm.png`) by two writers, for
`src/docx.test.ts`:

```sh
pandoc source.md -o pandoc.docx
pandoc source.md -o source.odt
soffice --headless --convert-to docx:"MS Word 2007 XML" source.odt   # then rename to libreoffice.docx
```

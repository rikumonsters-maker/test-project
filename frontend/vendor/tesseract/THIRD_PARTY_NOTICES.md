# OCR runtime notices

The browser OCR runtime is vendored for same-origin, offline-capable loading.

- `tesseract.esm.min.js` and `worker.min.js`: Tesseract.js 7.0.0, Apache-2.0.
- `tesseract-core-*-lstm.wasm.js`: tesseract.js-core 7.0.0, Apache-2.0.
- `lang/jpn.traineddata.gz`: Japanese LSTM model from `tesseract-ocr/tessdata_best`, ref `4.0.0_best`, Apache-2.0.
- `LICENSE-APACHE-2.0.txt`: Apache License 2.0 text applicable to these assets.

Sources:

- https://github.com/naptha/tesseract.js/tree/v7.0.0
- https://github.com/naptha/tesseract.js-core/tree/v7.0.0
- https://github.com/tesseract-ocr/tessdata_best/tree/4.0.0_best

SHA-256 for `lang/jpn.traineddata.gz`:

`5b7642156896ccdb39aea83db6238dd85c8fba14e0dd92ad7db29098bf0e7ddd`

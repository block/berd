# LibriSpeech `test-clean` benchmark fixture

The upstream archive includes this license notice:

> LibriSpeech (c) 2014 by Vassil Panayotov
>
> LibriSpeech ASR corpus is licensed under a Creative Commons Attribution 4.0
> International License.
>
> See <http://creativecommons.org/licenses/by/4.0/>.

These three unmodified FLAC files and their reference transcripts were
extracted from the LibriSpeech ASR corpus, OpenSLR resource SLR12:

- Source: https://www.openslr.org/12/
- Archive: https://www.openslr.org/resources/12/test-clean.tar.gz
- Published archive MD5: `32fa31d27d2e1cad72775fee3f4849a9`
- License: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)

The source archive's published checksum was verified before extracting the
three paths named in `manifest.json`. The transcript text was copied exactly
from each corresponding `*.trans.txt` file in that archive. The audio has not
been modified. `manifest.json` records the SHA-256, byte length, and decoded
stream metadata for each extracted file.

Please cite the corpus as:

> Vassil Panayotov, Guoguo Chen, Daniel Povey, and Sanjeev Khudanpur.
> “LibriSpeech: An ASR Corpus Based on Public Domain Audio Books.”
> ICASSP 2015.

The corpus was prepared from LibriVox public-domain audiobook recordings. The
Rust source code in this crate remains licensed under Apache License 2.0.

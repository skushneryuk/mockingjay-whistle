# Mockingjay Whistle Trainer

A local pitch trainer for the four-note Mockingjay signal. Use **EN** or **RU** to switch the interface language.

On narrow and touch screens, start and stop practice from the bottom bar. **Settings** in that bar opens the same controls as the desktop sidebar.

## Run locally

With Node.js installed, run:

```powershell
node server.mjs
```

Open [http://localhost:4173](http://localhost:4173). The browser asks for microphone access when you start practice. Pitch analysis runs on the device. Settings and the last 50 completed phrases are saved in the browser.

## Practice

- **Note by note** advances when you hold each target. **Echo** plays the sample and gives a count-in. **Rhythm** scores pitch and timing after a three-beat count-in. **Tuner** displays pitch without scoring.
- **Follow notes** aligns the trace with the reference. **Live trace** uses elapsed time and shows the last eight seconds of your actual pitch. You can switch views during practice.
- **Normal** is 50 BPM. Its first three notes each last 0.60 s, and the last lasts 0.78 s. **Slow** is 36 BPM and **Fast** is 65 BPM.
- **Beginner** accepts ±2 semitones, **Intermediate** accepts ±1 semitone, and **Advanced** accepts ±30 cents. If two target ranges overlap, a change in pitch or a short breath separates the holds.
- **Recorded** plays retuned excerpts from a real whistle. **Synthesized** uses a softer oscillator with gradual attack and release. Both follow the selected tempo, octave, and volume.

The pitch sequence is G–B♭–A–D. The Russian cards read Соль–Си–Ля–Ре, and the detailed Russian pitch readout marks the flat as Си♭.

## Publish later

Push the repository to GitHub. Under **Settings → Pages → Source**, choose **GitHub Actions**, then run **Publish to GitHub Pages** from the **Actions** tab. The manually triggered workflow uploads `dist/`. All assets use relative paths so the site can run under the repository’s Pages subpath. Pages serves it over HTTPS for microphone access. [GitHub Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

## Verify

```powershell
node --test tests/pitch.test.mjs
```

The local [QA page](http://localhost:4173/_qa.html) uses a synthetic MediaStream and separate browser storage. It tests the melody, silence, denied access, and permission granted after cancellation. Open the main page to check hardware microphone input.

## Credits

- The note sequence is documented in the [Mockingjay sound mark](https://trademarks.justia.com/854/09/n-85409089.html).
- The recorded samples are excerpts from [Whistle – Sustain tonal by Vrymaa](https://freesound.org/people/Vrymaa/sounds/797587/), released under [CC0](https://creativecommons.org/publicdomain/zero/1.0/). The clips were trimmed, filtered, and level-matched before playback retuning.
- The emblem in `dist/assets/mockingjay-pin.webp` was made and isolated with built-in ImageGen. The header mark and browser icon are a smaller export in `dist/favicon.png`.
- The dark bronze background in `dist/assets/blackened-bronze.webp` was made with built-in ImageGen.

<details>
<summary>Banner prompt</summary>

Create a wide 3:1 cinematic banner photograph for a minimalist Hunger Games Mockingjay whistle trainer website. Show a single original antique gold mockingbird pin inspired by the Mockingjay motif, a side-profile bird with one wing rising high and a subtly integrated slender arrow crossing an imperfect orbital ring. Intricate old engraved feather ridges, worn warm brass, small edge highlights. Center the complete pin horizontally and vertically, around 60 percent of image height. Keep all sides quiet and dark so it blends into a black-brown page. Almost black charcoal cloth or blackened metal background with fine grain and a very subtle warm low-lit haze behind the bird. High-end macro photograph of a real metal object with dimensional soft directional light, deep brown shadows, restrained palette of old gold and near-black. The pin is the only focal point. No words, letters, logos, typography, person, scenery, bright flames, or borders.

</details>

<details>
<summary>Emblem cutout prompt</summary>

Isolate the existing Mockingjay pin from this exact reference for a dark website masthead. Preserve the raised wing, left-facing bird, diagonal arrow, circular ring, and antique brass finish. Remove the dark cloth and every background pixel, including the open spaces inside the ring, so those spaces show the real transparent alpha channel. Keep the complete emblem centered in a square frame with about 8 percent transparent margin. Preserve the metallic highlights and fine feather engraving. Clean, antialiased edges. No cast shadow, backdrop, rectangular patch, glow, border, or letters.

</details>

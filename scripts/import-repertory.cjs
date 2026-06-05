#!/usr/bin/env node
/* eslint-disable no-unused-vars */
const fs = require('fs/promises');
const path = require('path');
const core = require('../lib/karaoke-core.js');

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function findCandidateManifest(folderPath) {
  const manifestPath = path.join(folderPath, 'manifest.json');
  const repertoryPath = path.join(folderPath, 'repertory.json');

  if (await fileExists(manifestPath)) {
    return manifestPath;
  }

  if (await fileExists(repertoryPath)) {
    return repertoryPath;
  }

  return null;
}

async function collectFiles(folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const resolved = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(resolved);
      results.push(...nested);
      continue;
    }

    results.push(resolved);
  }

  return results;
}

async function buildLibrary(folderPath) {
  const manifestPath = await findCandidateManifest(folderPath);
  if (manifestPath) {
    const manifest = await readJson(manifestPath);
    const songs = [];

    for (const song of manifest.songs || []) {
      const lyricsPath = song.lyricsPath ? path.join(folderPath, song.lyricsPath) : null;
      const audioPath = song.audioPath ? path.join(folderPath, song.audioPath) : null;
      const lyrics = lyricsPath && (await fileExists(lyricsPath))
        ? await fs.readFile(lyricsPath, 'utf8')
        : song.lyrics || song.lyricsText || '';

      songs.push(
        core.normalizeSong({
          id: song.id,
          title: song.title,
          artist: song.artist,
          genre: song.genre,
          mode: song.mode,
          duration: song.duration,
          pitchGuideHz: song.pitchGuideHz,
          pitchGuideLabel: song.pitchGuideLabel,
          audioUrl: audioPath && (await fileExists(audioPath)) ? audioPath : '',
          lyrics,
        }),
      );
    }

    return {
      title: manifest.title || path.basename(folderPath),
      songs,
    };
  }

  const files = await collectFiles(folderPath);
  const lyricFiles = files.filter((filePath) => filePath.toLowerCase().endsWith('.lrc'));
  const songs = [];

  for (const lyricFile of lyricFiles) {
    const lyrics = await fs.readFile(lyricFile, 'utf8');
    const base = path.basename(lyricFile, '.lrc');
    songs.push(
      core.normalizeSong({
        id: base,
        title: base.replace(/[-_]/g, ' '),
        artist: 'Importado localmente',
        genre: 'Karaoke',
        mode: 'solo',
        pitchGuideHz: null,
        lyrics,
      }),
    );
  }

  return {
    title: path.basename(folderPath),
    songs,
  };
}

async function main() {
  const folderPath = path.resolve(process.argv[2] || '.');
  const library = await buildLibrary(folderPath);
  process.stdout.write(JSON.stringify(library, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

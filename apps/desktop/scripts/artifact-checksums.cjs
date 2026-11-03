const { readFile, writeFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { basename } = require('node:path');
module.exports = async function (context) {
  for (const artifact of context.artifactPaths) {
    if (!artifact.endsWith('.exe')) continue;
    const digest = createHash('sha256')
      .update(await readFile(artifact))
      .digest('hex');
    await writeFile(artifact + '.sha256', `${digest}  ${basename(artifact)}\n`);
  }
  return [];
};

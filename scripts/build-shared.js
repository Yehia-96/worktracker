// Copies the shared logic into the iPhone web app (docs/) and the Supabase reminder service.
// Run after changing anything in src/shared or renderer/{base.css,icons.js}: `npm run build:web`
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(root, to));
};

for (const f of ['core.js', 'config.js', 'linux-commands.json']) {
  copy(`src/shared/${f}`, `docs/shared/${f}`);
  copy(`src/shared/${f}`, `supabase/functions/_shared/${f}`);
}
copy('renderer/base.css', 'docs/shared/base.css');
copy('renderer/icons.js', 'docs/shared/icons.js');
copy('node_modules/@supabase/supabase-js/dist/umd/supabase.js', 'docs/vendor/supabase.js');
fs.writeFileSync(path.join(root, 'docs/.nojekyll'), '');
require('./make-icons');
console.log('Shared files copied to docs/ and supabase/functions/_shared/');

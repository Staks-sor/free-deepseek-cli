import fs from 'fs';

let content = fs.readFileSync('api/openai-handler.mjs', 'utf8');

// I will just simplify the regex to ONLY remove text AFTER the LAST closing bracket if there are braces.
// Or just do a very reliable JSON repair since regexes are fragile.
// Better: remove ANY text that is not inside quotes? No.
// Let's just wrap the attempt block to print the exact failing string.
content = content.replace(
  'console.error("[API] Problematic JSON string was:\\n", jsonStr);',
  'console.error("[API] Problematic JSON string was:\\n", JSON.stringify(jsonStr));'
);

fs.writeFileSync('api/openai-handler.mjs', content);

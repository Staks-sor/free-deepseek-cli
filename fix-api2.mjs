import fs from 'fs';

let content = fs.readFileSync('api/openai-handler.mjs', 'utf8');

// I will just add logging to a file so we can see what goes wrong.
content = content.replace(
  'console.error("[API] Problematic JSON string was:\\n", JSON.stringify(jsonStr));',
  'fs.writeFileSync("/tmp/failed_json.txt", jsonStr); console.error("[API] Problematic JSON string was:\\n", JSON.stringify(jsonStr));'
);
if (!content.includes('fs.writeFileSync("/tmp/failed_json.txt"')) {
    content = content.replace(
      'console.error("[API] Problematic JSON string was:\\n", jsonStr);',
      'fs.writeFileSync("/tmp/failed_json.txt", jsonStr); console.error("[API] Problematic JSON string was:\\n", JSON.stringify(jsonStr));'
    );
}

// Ensure fs is imported at top if not there
if (!content.includes("import fs from 'fs';")) {
  content = "import fs from 'fs';\n" + content;
}

fs.writeFileSync('api/openai-handler.mjs', content);

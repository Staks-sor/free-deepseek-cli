import fs from 'fs';

let content = fs.readFileSync('api/openai-handler.mjs', 'utf8');

// Inside `onEnd()` for StreamParser, we have:
// let jsonStr = this.toolsBuffer;
// const firstBracket = jsonStr.indexOf("[");
// const lastBracket = jsonStr.lastIndexOf("]");

// We should replace it with this:
content = content.replace(
  'const lastBracket = jsonStr.lastIndexOf("]");',
  'let lastBracket = jsonStr.indexOf("```");\n      if (lastBracket !== -1) {\n        jsonStr = jsonStr.slice(0, lastBracket);\n        lastBracket = jsonStr.lastIndexOf("]");\n      } else {\n        lastBracket = jsonStr.lastIndexOf("]");\n      }'
);

fs.writeFileSync('api/openai-handler.mjs', content);

'use strict';

/**
 * 把 作业抓题助手.user.js 内联进 install.html，输出单文件安装页。
 *
 * 用法： node build.js
 * 什么时候要跑：改完 .user.js 之后跑一次，否则安装页里还是旧代码。
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SRC_FILE = path.join(DIR, '作业抓题助手.user.js');
const HTML_FILE = path.join(DIR, 'install.html');

if (!fs.existsSync(SRC_FILE)) {
  console.error('找不到 ' + SRC_FILE);
  process.exit(1);
}

const src = fs.readFileSync(SRC_FILE, 'utf8').replace(/\r\n/g, '\n').trim() + '\n';

if (/<\/script/i.test(src)) {
  console.error('脚本里包含 </script，会提前闭合内联块，先转义再跑');
  process.exit(1);
}

let html = fs.readFileSync(HTML_FILE, 'utf8');
const re = /(<script type="text\/plain" id="userscript-src">)([\s\S]*?)(<\/script>)/;

if (!re.test(html)) {
  console.error('install.html 里没找到 id="userscript-src" 的占位块');
  process.exit(1);
}

html = html.replace(re, (m, open, inner, close) => open + '\n' + src + close);
fs.writeFileSync(HTML_FILE, html, 'utf8');

const after = fs.readFileSync(HTML_FILE, 'utf8');
const back = (after.match(re) || [])[2] || '';
const same = back.trim() === src.trim();
const version = (src.match(/@version\s+([\d.]+)/) || [])[1] || '?';

console.log('内联完成');
console.log('  脚本版本  : v' + version);
console.log('  脚本大小  : ' + (src.length / 1024).toFixed(1) + ' KB');
console.log('  安装页大小: ' + (after.length / 1024).toFixed(1) + ' KB');
console.log('  回读校验  : ' + (same ? '一致' : '不一致！'));

process.exit(same ? 0 : 1);

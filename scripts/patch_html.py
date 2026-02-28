import re

f = '/opt/her/public/index.html'
c = open(f).read()
changed = False

# Patch A: Remove emoji from optgroup labels
c2 = re.sub(r'<optgroup label="[^"]*\u65d7\u8230">', '<optgroup label="\u65d7\u8230">', c)
c2 = re.sub(r'<optgroup label="[^"]*\u5747\u8861">', '<optgroup label="\u5747\u8861">', c2)
c2 = re.sub(r'<optgroup label="[^"]*\u7701\u9322">', '<optgroup label="\u7701\u9322">', c2)
# Patch B: Update Opus to 4.6
c2 = re.sub(r'<option value="claude-opus-4-[^"]*">Opus 4\.[0-9]+', '<option value="claude-opus-4-6">Opus 4.6', c2)
# Patch C: Reconnect notification instead of reload
old = '      // \u91cd\u8fde\u540e\u5237\u65b0\u9875\u9762\uff0c\u8ba9\u5bf9\u8bdd\u5386\u53f2\u91cd\u65b0\u52a0\u8f7d\n      wasDisconnected=false;\n      window.location.reload();'
new = '      wasDisconnected=false;\n      finishCmd();\n      setGenerating(false);\n      toast("\u2705 \u91cd\u65b0\u8fde\u63a5\u6210\u529f");\n      const _s=document.createElement("div");\n      _s.className="msg";\n      _s.style.cssText="justify-content:center;margin:8px 0";\n      _s.innerHTML=\'<span style="font-size:12px;color:var(--text3);background:var(--bg2);padding:4px 14px;border-radius:12px;border:1px solid var(--border)">\ud83d\udd04 \u670d\u52a1\u5668\u5df2\u91cd\u542f\uff0c\u53ef\u4ee5\u7ee7\u7bca\u5bf9\u8bdd\u4e86</span>\';\n      msgList.appendChild(_s);\n      scrollDown();'
if old in c2:
    c2 = c2.replace(old, new)

if c2 != c:
    open(f,'w').write(c2)
    print('patch_html: applied changes')
else:
    print('patch_html: already clean')

(() => {
	try { delete window.confDump; } catch {}

	// Utilities
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const ABS = href => { try { return new URL(href, location.origin).href; } catch { return href; } };
	const $ = s => document.querySelector(s);
	const getApiBases = () => {
		const underWiki = location.pathname.startsWith('/wiki/');
		return { v1: underWiki ? '/wiki/rest/api' : '/rest/api', v2: underWiki ? '/wiki/api/v2' : '/api/v2' };
	};

	// Common arrays and mappings
	const META_NAMES = [
		['ajs-page-id', 'confluence-page-id'],
		['ajs-page-title', 'confluence-page-title'],
		['ajs-space-key', 'confluence-space-key']
	];
	const LANG_MAP = {
		'c#': 'csharp', 'f#': 'fsharp', 'c++': 'cpp', 'objective-c': 'objectivec', 'objc': 'objectivec',
		'js': 'javascript', 'ts': 'typescript', 'sh': 'bash', 'shell': 'bash', 'zsh': 'bash', 'java': 'java',
		'text': '', 'plaintext': '', 'console': '', 'yml': 'yaml', 'json5': 'json', 'ps1': 'powershell', 'ps': 'powershell'
	};
	const PANEL_MAP = { info: 'NOTE', note: 'IMPORTANT', tip: 'TIP', success: 'TIP', warning: 'WARNING', error: 'WARNING', danger: 'CAUTION', caution: 'CAUTION' };
	const EMOTICON_FILE_TO_EMOJI = {
		'star_blue.png': '⭐', 'star_green.png': '💚', 'star_yellow.png': '🌟',
		'warning.png': '⚠️', 'information.png': 'ℹ️', 'check.png': '✅',
		'error.png': '❌', 'lightbulb_on.png': '💡', 'megaphone.png': '📣', 'rocket.png': '🚀'
	};

	const API = getApiBases();
	let preferHtmlForDataImages = true;
	let requestDelayMs = 5000;           // default 5 seconds between requests
	let suppressTocWithAnchors = true;   // default: do not include ToC with anchor links

	// Common ID extraction logic
	const extractId = href => {
		try {
			const u = new URL(href, location.origin);
			const pid = u.searchParams.get('pageId') || u.searchParams.get('homepageId');
			if (pid && /^\d+$/.test(pid)) return pid;
			const parts = u.pathname.split('/').filter(Boolean);
			const idx = parts.indexOf('pages');
			if (idx >= 0 && /^\d+$/.test(parts[idx + 1] || '')) return parts[idx + 1];
		} catch {}
		return '';
	};

	const getPageContext = () => {
		const vals = META_NAMES.map(names => names.map(n => $(`meta[name="${n}"]`)).find(Boolean)?.content || '');
		return {
			id: vals[0] || extractId(location.href),
			title: vals[1] || document.title.replace(/\s+-\s+Confluence.*$/i, '') || '',
			spaceKey: vals[2]
		};
	};

	const parseInput = input => {
		const s = String(input || '').trim();
		if (!s) throw new Error('No input');
		if (/^\d+$/.test(s)) return s;
		const id = extractId(s);
		if (id) return id;
		throw new Error('Unrecognized Confluence URL or ID');
	};

	// Generic API caller with rate limiting
	const apiCall = async (version, path, params = {}) => {
		const url = new URL(API[version] + path, location.origin);
		Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

		// Rate limit: delay between requests
		if (requestDelayMs > 0) {
			await sleep(requestDelayMs);
		}

		const res = await fetch(url.href, { credentials: 'include' });
		if (res.status === 429) {
			await sleep((Number(res.headers.get('retry-after')) || 5) * 1000);
			return apiCall(version, path, params);
		}
		if (version === 'v2' && res.status === 404) return null;
		if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.pathname}`);
		return res.json();
	};

	const fetchPage = id => apiCall('v1', `/content/${encodeURIComponent(id)}`, {
		expand: 'body.view,body.storage,body.atlas_doc_format,version,ancestors,space,metadata.labels'
	});

	const fetchChildrenV1 = async (id, limit = 200) => {
		const results = [];
		let start = 0;
		while (true) {
			const data = await apiCall('v1', `/content/${encodeURIComponent(id)}/child/page`, {
				expand: 'body.view,version,space,ancestors',
				limit: String(limit),
				start: String(start)
			});
			if (Array.isArray(data.results)) results.push(...data.results);
			if (!data._links?.next) break;
			start += limit;
		}
		return results;
	};

	const fetchComments = async (pageId, opts) => {
		if (opts.where === 'none') return { footer: [], inline: [] };

		const [wantFooter, wantInline] = [
			['footer', 'both'].includes(opts.where),
			['inline', 'both'].includes(opts.where)
		];

		const out = { footer: [], inline: [] };

		const shapeComment = c => {
			const getValue = (...keys) => keys.map(k => k.split('.').reduce((o, p) => o?.[p], c)).find(Boolean) || '';
			return {
				id: getValue('id', 'content.id') || c?._links?.self?.split('/').pop() || null,
				parentId: getValue('parentId', 'container.id'),
				location: (c?.location === 'inline' || c?.anchor || c?.inlineProperties || c?.extensions?.inlineProperties) ? 'inline' : 'footer',
				author: getValue('author.displayName', 'createdBy.displayName', 'version.by.displayName', 'version.by.publicName'),
				created: getValue('createdAt', 'createdDate', 'version.when', 'created'),
				updated: getValue('updatedAt', 'updatedDate'),
				status: getValue('status', 'properties.status', 'extensions.resolution.status'),
				bodyHtml: getValue('body.view.value', 'body.storage.value', 'body.plain.value'),
				bodyStorage: getValue('body.storage.value'),
				quotedText: getValue('extensions.inlineProperties.originalSelection')
			};
		};

		// Try V2 API first
		const fetchV2Comments = async location => {
			const results = [];
			let cursor = null;
			while (true) {
				const params = { location, limit: '100', sort: 'created-date', 'body-format': 'storage' };
				if (opts.thread === 'all') params.depthType = 'all';
				if (cursor) params.cursor = cursor;

				const data = await apiCall('v2', `/pages/${encodeURIComponent(pageId)}/comments`, params);
				if (!data) break;

				const arr = Array.isArray(data.results) ? data.results : Array.isArray(data.data) ? data.data : [];
				results.push(...arr);
				cursor = data._links?.next || data._links?.nextCursor || data.next || null;
				if (!cursor) break;
			}
			return results;
		};

		try {
			if (wantFooter) (await fetchV2Comments('footer')).forEach(c => out.footer.push(shapeComment(c)));
			if (wantInline) (await fetchV2Comments('inline')).forEach(c => out.inline.push(shapeComment(c)));
		} catch {}

		// V1 fallback if needed
		if ((wantFooter && !out.footer.length) || (wantInline && !out.inline.length)) {
			let start = 0, limit = 200;
			while (true) {
				const v1 = await apiCall('v1', `/content/${encodeURIComponent(pageId)}/child/comment`, {
					expand: 'body.view,body.storage,version,container,extensions.inlineProperties,extensions.resolution',
					limit: String(limit),
					start: String(start)
				}).catch(() => null);
				if (!v1) break;

				(Array.isArray(v1.results) ? v1.results : []).forEach(c => {
					const shaped = shapeComment(c);
					if (out[shaped.location]) out[shaped.location].push(shaped);
				});

				if (!v1._links?.next) break;
				start += limit;
			}
		}

		// Apply filters
		if (!opts.includeResolved) {
			out.inline = out.inline.filter(c => String(c.status || '').toLowerCase() !== 'resolved');
		}
		if (opts.thread === 'root') {
			out.inline = out.inline.filter(c => !c.parentId || String(c.parentId) === String(pageId));
		}

		return out;
	};

	// Image utilities
	const isEmojiLike = img => /emoticon|emoji/i.test(img.className || '') || /\/images\/icons\/emoticons\//i.test(img.getAttribute('src') || '');

	const resolveImageSrc = el => {
		const raw = ['data-image-src', 'data-src', 'src'].map(attr => el.getAttribute(attr)).find(Boolean) || '';
		return raw ? ABS(raw.replace('/download/thumbnails/', '/download/attachments/')) : '';
	};

	const resolveRedirectOnce = async url => {
		try {
			const u = new URL(url, location.href);
			if (u.origin !== location.origin) return url;
		} catch { return url; }

		const res = await fetch(url, { credentials: 'include', redirect: 'manual', mode: 'same-origin' });
		if (res.status >= 200 && res.status < 300) return url;
		const loc = res.headers.get('location');
		if (loc) { try { return new URL(loc, url).href; } catch { return loc; } }
		return url;
	};

	const credsForUrl = u => { try { return new URL(u, location.href).origin === location.origin ? 'include' : 'omit'; } catch { return 'omit'; } };

	const getFinalUrlViaImg = initialUrl => new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img.currentSrc || initialUrl);
		img.onerror = () => reject(new Error('image load failed'));
		Object.assign(img, {
			decoding: 'async',
			style: 'position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;pointer-events:none;'
		});
		document.body.appendChild(img);
		img.src = initialUrl;
		setTimeout(() => { try { img.remove(); } catch {} }, 15000);
	});

	const blobFromUrlSmart = async initialUrl => {
		let url = initialUrl;
		try { url = await resolveRedirectOnce(initialUrl); } catch {}

		const tryFetch = async (fetchUrl, creds) => {
			const resp = await fetch(fetchUrl, { credentials: creds, mode: 'cors', redirect: 'follow' });
			if (resp.ok) return resp.blob();
			throw new Error('fetch failed');
		};

		try { return await tryFetch(url, credsForUrl(url)); } catch {}
		try {
			const finalUrl = await getFinalUrlViaImg(url);
			return await tryFetch(finalUrl, 'omit');
		} catch {}
		throw new Error('unfetchable');
	};

	const embedImagesInHtml = async html => {
		const parser = new DOMParser();
		const doc = parser.parseFromString(String(html || ''), 'text/html');
		const imgs = Array.from(doc.querySelectorAll('img'));

		for (const img of imgs) {
			if (isEmojiLike(img)) continue;
			const raw = resolveImageSrc(img);
			if (!raw || raw.startsWith('data:')) continue;

			try {
				const preferred = await resolveRedirectOnce(raw);
				const blob = await blobFromUrlSmart(preferred);
				const dataUrl = await new Promise((resolve, reject) => {
					const fr = new FileReader();
					fr.onload = () => resolve(fr.result);
					fr.onerror = reject;
					fr.readAsDataURL(blob);
				});
				img.setAttribute('src', String(dataUrl));
				['data-image-src', 'data-src'].forEach(attr => img.removeAttribute(attr));
			} catch {
				img.setAttribute('src', raw);
			}
		}
		return doc.body.innerHTML;
	};

	// Markdown conversion utilities
	const normalizeLang = (lang, text) => {
		let l = (lang || '').toString().trim().toLowerCase();
		if (!l && text && /^\s*curl\s/i.test(text)) l = 'bash';
		return LANG_MAP[l] ?? l;
	};

	const extractLang = el => {
		const pre = el.closest('pre');
		const getBrush = elem => elem?.getAttribute('data-syntaxhighlighter-params')?.match(/\bbrush:\s*([^;]+)/i)?.[1];

		const sources = [
			el.getAttribute('data-language'),
			getBrush(el),
			(el.className || '').match(/\b(?:language|lang)-([A-Za-z0-9#+.-]+)\b/i)?.[1],
			pre?.getAttribute('data-language'),
			getBrush(pre),
			(pre?.className || '').match(/\b(?:language|lang)-([A-Za-z0-9#+.-]+)\b/i)?.[1]
		];
		return normalizeLang(sources.find(Boolean) || '', el.textContent || '');
	};

	const looksLikeBlockCode = el => {
		const style = (el.getAttribute('style') || '').toLowerCase();
		return style.includes('white-space:pre') || /\n/.test(el.textContent || '');
	};

	const detectPanelType = el => {
		let t = (el.getAttribute('data-panel-type') || '').toLowerCase();
		if (!t) {
			const cls = (el.className || '').toLowerCase();
			if (/\bconfluence-information-macro\b/.test(cls)) {
				const match = cls.match(/confluence-information-macro-([a-z]+)/);
				if (match) t = match[1];
			} else if (/\bak-renderer-panel\b/.test(cls)) {
				const types = ['warning', 'tip', 'success', 'note', 'info'];
				t = types.find(type => new RegExp(`\\b${type}\\b`).test(cls)) || '';
			} else if (/\baui-message\b/.test(cls)) {
				if (/\bwarning\b/.test(cls)) t = 'warning';
				else if (/\berror|danger\b/.test(cls)) t = 'caution';
				else if (/\bsuccess\b/.test(cls)) t = 'tip';
				else t = 'info';
			} else if (/\bpanel\b/.test(cls) && /\bconf-macro\b/.test(cls)) {
				if (!/\bcode\b/.test(cls)) {
					t = 'info';
				}
			}
		}
		return PANEL_MAP[t] || null;
	};

	const generateTocFromHtml = (html) => {
		const headings = [];
		const parser = new DOMParser();
		const doc = parser.parseFromString(html, 'text/html');
		doc.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
			if (h.id && h.textContent) {
				headings.push({
					level: parseInt(h.tagName.substring(1), 10),
					title: h.textContent.trim(),
					slug: h.id
				});
			}
		});
		if (headings.length < 2) return '';
		const tocLines = [];
		for (const heading of headings) {
			const indent = '  '.repeat(Math.max(0, heading.level - 1));
			tocLines.push(`${indent}- [${heading.title}](#${heading.slug})`);
		}
		return tocLines.join('\n') + '\n';
	};

	const htmlToMarkdown = html => {
		const parser = new DOMParser();
		const doc = parser.parseFromString(String(html || ''), 'text/html');

		const escInline = s => s.replace(/\\/g, '\\\\').replace(/([*_`[\]|])/g, '\\$1').replace(/\u00A0/g, ' ');
		const joinInline = parts => {
			let out = '';
			for (const p of parts) {
				if (!p) continue;
				if (out && /\w$/.test(out) && /^\w/.test(p)) out += ' ';
				out += p;
			}
			return out;
		};

		function renderAdmonition(el, type, ctx) {
			const inner = Array.from(el.childNodes).map(c => render(c, ctx)).join('').trim();
			const lines = inner.split('\n').map(l => l ? `> ${l}` : '>').join('\n');
			return `\n> [!${type}]\n${lines}\n`;
		}

		function render(node, ctx = { listDepth: 0, olIndex: [] }) {
			if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue || '').replace(/\s+/g, ' ');
			if (node.nodeType !== Node.ELEMENT_NODE) return '';

			const el = node, tag = el.tagName.toLowerCase();

			if (['div', 'aside', 'section'].includes(tag)) {
				const callout = detectPanelType(el);
				if (callout) return renderAdmonition(el, callout, ctx);
			}

			const childrenMd = () => Array.from(el.childNodes).map(c => render(c, ctx));
			const joinedChildren = () => joinInline(childrenMd());

			const handlers = {
				'span': joinedChildren,
				'div': () => {
					if (el.matches('.toc-macro')) return '\n__TOC_PLACEHOLDER__\n';

					if (el.matches('.expand-container')) {
						const summaryEl = el.querySelector('.expand-control-text');
						const contentEl = el.querySelector('.expand-content');
						const summaryText = summaryEl ? summaryEl.textContent.trim() : 'Details';
						const contentMd = contentEl ? Array.from(contentEl.childNodes).map(c => render(c, ctx)).join('').trim() : '';
						return `\n<details>\n<summary>${summaryText}</summary>\n\n${contentMd}\n\n</details>\n`;
					}

					const isCodePanel = /\bcode\b/i.test(el.className) && el.querySelector('pre, code');
					if (isCodePanel) {
						const code = el.querySelector('pre, code');
						const langHint = extractLang(code || el);
						const content = (code ? code.textContent : el.textContent) || '';
						return `\n\`\`\`${langHint}\n${content.replace(/\s+$/,'')}\n\`\`\`\n`;
					}
					return joinedChildren();
				},
				'h1': () => `\n<a id="${el.id || ''}"></a>\n# ${joinedChildren().trim()}\n`,
				'h2': () => `\n<a id="${el.id || ''}"></a>\n## ${joinedChildren().trim()}\n`,
				'h3': () => `\n<a id="${el.id || ''}"></a>\n### ${joinedChildren().trim()}\n`,
				'h4': () => `\n<a id="${el.id || ''}"></a>\n#### ${joinedChildren().trim()}\n`,
				'h5': () => `\n<a id="${el.id || ''}"></a>\n##### ${joinedChildren().trim()}\n`,
				'h6': () => `\n<a id="${el.id || ''}"></a>\n###### ${joinedChildren().trim()}\n`,
				'p': () => {
					const txt = joinedChildren().trim();
					return txt ? `\n${txt}\n` : '\n\n';
				},
				'br': () => '  \n',
				'strong': () => `**${joinedChildren()}**`,
				'b': () => `**${joinedChildren()}**`,
				'em': () => `*${joinedChildren()}*`,
				'i': () => `*${joinedChildren()}*`,
				'u': joinedChildren,
				'del': () => `~~${joinedChildren()}~~`,
				's': () => `~~${joinedChildren()}~~`,
				'strike': () => `~~${joinedChildren()}~~`,
				'code': () => {
					const text = el.textContent || '';
					const lang = extractLang(el);
					if (looksLikeBlockCode(el) && !el.closest('pre')) {
						return `\n\`\`\`${lang}\n${text.replace(/\s+$/,'')}\n\`\`\`\n`;
					}
					return `\`${text.replace(/`/g, '\\`')}\``;
				},
				'pre': () => {
					const codeEl = el.querySelector('code');
					const lang = extractLang(codeEl || el);
					const body = codeEl ? codeEl.textContent : el.textContent;
					return `\n\`\`\`${lang}\n${(body || '').replace(/\s+$/,'')}\n\`\`\`\n`;
				},
				'blockquote': () => {
					const inner = childrenMd().join('').trimEnd();
					const quoted = inner.split('\n').map(l => `> ${l}`).join('\n');
					return `\n${quoted}\n`;
				},
				'a': () => {
					const href = ABS(el.getAttribute('href') || '');
					const label = joinedChildren() || href;
					return `[${label}](${href})`;
				},
				'img': () => {
					const src = resolveImageSrc(el);
					const finalSrc = src.startsWith('data:') ? src : ABS(src);
					const alt = el.getAttribute('alt') || el.getAttribute('data-linked-resource-default-alias') || '';

					if (preferHtmlForDataImages && finalSrc.startsWith('data:')) {
						return `<img src="${finalSrc}" alt="${escInline(alt)}">`;
					}

					const file = (finalSrc.split('/').pop() || '').toLowerCase();
					const short = el.getAttribute('data-emoji-shortname') || el.getAttribute('data-emoticon-name') || '';

					if (short && /^:.*:$/.test(short)) return short;
					if (isEmojiLike(el)) return EMOTICON_FILE_TO_EMOJI[file] || alt.replace(/[()]/g, '').trim() || '';
					return `![${escInline(alt)}](${finalSrc})`;
				},
				'ul': () => renderList(false),
				'ol': () => renderList(true),
				'table': () => {
					const cellToInline = cell => {
						const md = Array.from(cell.childNodes).map(c => render(c, ctx)).join('').trim();
						return md.replace(/\n+/g, '<br>').replace(/\|/g, '\\|') || ' ';
					};
					const rows = Array.from(el.querySelectorAll('tr'));
					if (!rows.length) return '';

					const headCells = Array.from(rows[0].querySelectorAll('th,td')).map(cellToInline);
					const bodyRows = rows.slice(1).map(r => Array.from(r.querySelectorAll('td,th')).map(cellToInline));

					const header = `| ${headCells.join(' | ')} |`;
					const sep = `| ${headCells.map(() => '---').join(' | ')} |`;
					const body = bodyRows.map(r => `| ${r.join(' | ') } |`).join('\n');
					return `\n${header}\n${sep}\n${body}\n`;
				},
				'hr': () => '\n---\n'
			};

			function renderList(isOl) {
				const newCtx = { ...ctx, listDepth: ctx.listDepth + 1, olIndex: isOl ? [...ctx.olIndex, 0] : ctx.olIndex };
				const items = Array.from(el.children).filter(li => li.tagName.toLowerCase() === 'li');
				const lines = [];

				for (const li of items) {
					const indent = '  '.repeat(newCtx.listDepth - 1);
					if (isOl) newCtx.olIndex[newCtx.olIndex.length - 1]++;
					const marker = isOl ? `${newCtx.olIndex[newCtx.olIndex.length - 1]}. ` : '- ';

					const chk = li.querySelector('input[type="checkbox"]');
					const prefix = chk ? `[${chk.checked ? 'x' : ' '}] ` : '';
					const liMd = joinInline(Array.from(li.childNodes).map(c => render(c, newCtx))).trim();
					const firstLine = `${indent}${marker}${prefix}${liMd.split('\n')[0] || ''}`;
					const extra = liMd.split('\n').slice(1).map(x => `${indent}  ${x}`);
					lines.push(firstLine, ...extra);
				}
				return `\n${lines.join('\n')}\n`;
			}

			return handlers[tag] ? handlers[tag]() : joinedChildren();
		}

		return render(doc.body).replace(/\n{3,}/g, '\n\n').trim() + '\n';
	};

	const htmlToMarkdownWithEmbedding = async (html, embedImages) =>
		embedImages ? htmlToMarkdown(await embedImagesInHtml(html)) : htmlToMarkdown(html);

	const pageToMarkdown = async (page, embedImages) => {
		const { id, title, space, version } = page;
		const url = ABS(page._links?.webui ? page._links.base + page._links.webui : location.href);
		const { when, by } = page.version || {};

		const frontmatter = [
			'---',
			`id: ${id}`,
			`title: ${(title || '').replace(/"/g, '\\"')}`,
			`space: ${space?.key || ''}`,
			`url: ${url}`,
			`version: ${version?.number || ''}`,
			when && `updated: ${when}`,
			by && `updatedBy: "${(by.displayName || by.publicName || '').replace(/"/g, '\\"')}"`
		].filter(Boolean).join('\n') + '\n---\n\n';

		const html = page.body?.view?.value || '';
		let bodyMd = await htmlToMarkdownWithEmbedding(html, embedImages);

		if (bodyMd.includes('__TOC_PLACEHOLDER__')) {
			if (suppressTocWithAnchors) {
				// Remove placeholder completely when ToC with anchors is disabled
				bodyMd = bodyMd.replace('__TOC_PLACEHOLDER__', '');
			} else {
				const tocMd = generateTocFromHtml(html);
				bodyMd = bodyMd.replace('__TOC_PLACEHOLDER__', tocMd);
			}
		}

		return frontmatter + bodyMd;
	};

	const commentsToMarkdown = async (comments, embedImages = false) => {
		const lines = [];

		if (comments.footer && comments.footer.length > 0) {
			lines.push('\n---\n', '## Footer Comments\n');
			for (const c of comments.footer) {
				const when = c.created ? new Date(c.created).toLocaleDateString() : '';
				const by = c.author || 'unknown';
				const bodyMd = await htmlToMarkdownWithEmbedding(c.bodyHtml || c.bodyStorage || '', embedImages);
				const bodyTrim = bodyMd.trim();

				if (!bodyTrim.includes('\n')) {
					lines.push(`- **${by}** (${when}): ${bodyTrim}`);
				} else {
					lines.push(`- **${by}** (${when}):`);
					lines.push(bodyTrim.split('\n').map(l => `  > ${l}`).join('\n'));
				}
			}
		}

		if (comments.inline && comments.inline.length > 0) {
			lines.push('\n---\n');
			lines.push('<details>');
			lines.push('<summary>Inline Comments</summary>\n');

			for (const comment of comments.inline) {
				const commentMd = await htmlToMarkdownWithEmbedding(comment.bodyHtml || comment.bodyStorage || '', embedImages);
				lines.push('---');
				if (comment.quotedText) {
					lines.push(`> ${comment.quotedText.replace(/\n/g, '\n> ')}\n`);
				}
				lines.push(commentMd.trim());
				lines.push(`\n*— ${comment.author || 'unknown'}*`);
			}

			lines.push('\n---');
			lines.push('</details>\n');
		}

		return lines.length > 0 ? lines.join('\n') + '\n' : '';
	};

	const saveFile = async (filename, data) => {
		const blob = new Blob(["\uFEFF", data], { type: 'application/octet-stream;charset=utf-8' });

		try {
			if (window.showSaveFilePicker) {
				const handle = await window.showSaveFilePicker({ suggestedName: filename });
				const writable = await handle.createWritable();
				await writable.write(blob);
				await writable.close();
				return;
			}
		} catch {}

		const url = URL.createObjectURL(blob);
		const a = Object.assign(document.createElement('a'), {
			href: url, download: filename, rel: 'noopener', style: 'display:none'
		});
		document.body.appendChild(a);
		requestAnimationFrame(() => {
			a.click();
			setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 10000);
		});
	};

	function buildModal() {
		const wrap = document.createElement('div');
		const { id: currentId } = getPageContext();

		wrap.innerHTML = `
			<style>
				#cdBackdrop{position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:2147483646}
				#cdCard{
					position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
					width:640px;max-width:95%;
					background:#fff;border:1px solid #d1d5db;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.25);
					z-index:2147483647;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
					display:flex;flex-direction:column;max-height:90vh;overflow:hidden
				}
				#cdCard, #cdCard *, #cdCard *::before, #cdCard *::after { box-sizing: border-box }
				#cdCard header{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #eee}
				#cdCard h3{margin:0;font-size:15px;font-weight:600}
				#cdCard form{flex:1 1 auto;overflow:auto;overflow-x:hidden;padding:12px 14px}
				#cdCard label{display:block;font-size:12px;color:#374151;margin:8px 0 4px}
				#cdCard input[type="text"],#cdCard input[type="number"],#cdCard select{
					width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;
				}
				#cdInput{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
				#cdRow{display:flex;gap:8px;flex-wrap:wrap}
				#cdRow>div{flex:1;min-width:160px;min-height:1px}
				#cdActions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px;align-items:center;position:sticky;bottom:0;background:#fff;padding-top:8px}
				#cdActions button{padding:8px 12px;border-radius:8px;border:1px solid #d1d5db;background:#f9fafb;cursor:pointer}
				#cdActions button.primary{background:#111827;color:#fff;border-color:#111827}
				#cdClose{all:unset;cursor:pointer;font-size:18px;line-height:1}
				#cdStatus{display:flex;align-items:center;gap:8px;font-size:12px;color:#374151;visibility:hidden}
				.cdSpinner{width:14px;height:14px;border:2px solid #e5e7eb;border-top-color:#111827;border-radius:50%;animation:cdSpin 0.8s linear infinite}
				@keyframes cdSpin{to{transform:rotate(360deg)}}
				#cdSummary{margin-top:12px;display:none}
				#cdSummary table{width:100%;border-collapse:collapse;font-size:12px}
				#cdSummary th,#cdSummary td{padding:4px 6px;text-align:left;border-bottom:1px solid #e5e7eb}
				#cdSummary th{font-weight:600;background:#f9fafb}
				#cdNote{font-size:11px;color:#6b7280;margin-top:8px}
				#cdCheck{display:flex;align-items:center;gap:8px}
			</style>
			<div id="cdBackdrop"></div>
			<div id="cdCard" role="dialog" aria-modal="true">
				<header><h3>confDump</h3><button id="cdClose" title="Close">×</button></header>
				<form>
					<label>Page URL or ID</label>
					<input id="cdInput" type="text" placeholder="123456789 or https://…/wiki/spaces/KEY/pages/123456789/Title" value="${currentId || ''}">
					<div id="cdRow">
						<div><label>Format</label><select id="cdFormat"><option value="markdown" selected>markdown</option><option value="json">json</option></select></div>
						<div><label>Include child pages</label><select id="cdChildren"><option value="no" selected>no</option><option value="yes">yes</option></select></div>
						<div><label>Child depth</label><input id="cdDepth" type="number" min="1" value="1"></div>
					</div>
					<div id="cdRow">
						<div><label>Comments</label><select id="cdComments"><option value="both" selected>both</option><option value="footer">footer only</option><option value="inline">inline only</option><option value="none">none</option></select></div>
						<div><label>Thread depth</label><select id="cdThread"><option value="all" selected>all replies</option><option value="root">root only</option></select></div>
						<div id="cdCheck"><input id="cdIncludeResolved" type="checkbox"><label for="cdIncludeResolved">Include resolved inline comments</label></div>
					</div>
					<div id="cdRow">
						<div id="cdCheck"><input id="cdEmbedImages" type="checkbox"><label for="cdEmbedImages">Embed images as data URLs (Markdown)</label></div>
						<div id="cdCheck"><input id="cdUseHtmlForData" type="checkbox" checked><label for="cdUseHtmlForData">Use HTML &lt;img&gt; for data URLs</label></div>
						<div id="cdCheck"><input id="cdNoToc" type="checkbox" checked><label for="cdNoToc">Do not include ToC with anchor links</label></div>
					</div>
					<div id="cdRow">
						<div><label>Delay between requests (seconds)</label><input id="cdRequestDelay" type="number" min="0" value="5"></div>
					</div>
					<div id="cdActions">
						<div id="cdStatus"><div class="cdSpinner"></div><span id="cdStatusText">Working…</span></div>
						<button type="button" id="cdCancel">Cancel</button>
						<button type="submit" class="primary" id="cdSubmit">Export</button>
					</div>
					<div id="cdSummary"></div>
					<div id="cdNote">Uses same origin ${API.v1} and ${API.v2} when available. Exports only what you can view.</div>
				</form>
			</div>
		`;

		document.body.appendChild(wrap);

		const [statusWrap, statusText, summaryBox, submitBtn] = ['#cdStatus', '#cdStatusText', '#cdSummary', '#cdSubmit'].map(s => wrap.querySelector(s));

		const setBusy = (on, text) => {
			statusWrap.style.visibility = on ? 'visible' : 'hidden';
			if (text) statusText.textContent = text;
			submitBtn.disabled = on;
		};

		const setStatus = text => statusText.textContent = text;

		const showSummary = obj => {
			const rows = [
				['title', obj.title], ['id', obj.id], ['space', obj.space || ''], ['version', obj.version || '']
			];
			if (obj.children_exported != null) rows.push(['children_exported', obj.children_exported]);
			if (obj.comments) rows.push(['footer_comments', obj.comments.footer], ['inline_comments', obj.comments.inline]);
			rows.push(['file', obj.filename]);

			summaryBox.innerHTML = `<table><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>${rows.map(([k,v])=>`<tr><td>${k}</td><td>${String(v)}</td></tr>`).join('')}</tbody></table>`;
			summaryBox.style.display = 'block';
		};

		const close = () => wrap.remove();

		wrap.querySelector('#cdBackdrop').onclick = close;
		wrap.querySelector('#cdClose').onclick = close;
		wrap.querySelector('#cdCancel').onclick = close;

		wrap.querySelector('form').onsubmit = async e => {
			e.preventDefault();

			const getVal = id => wrap.querySelector(id).value;
			const getChecked = id => wrap.querySelector(id).checked;

			const [
				input, format, includeChildren, depth,
				commentsWhere, threadDepth, includeResolved,
				embedImages, noToc, requestDelaySec
			] = [
				getVal('#cdInput').trim(),
				getVal('#cdFormat'),
				getVal('#cdChildren') === 'yes',
				Math.max(1, Number(getVal('#cdDepth')) || 1),
				getVal('#cdComments'),
				getVal('#cdThread'),
				getChecked('#cdIncludeResolved'),
				getChecked('#cdEmbedImages'),
				getChecked('#cdNoToc'),
				Math.max(0, Number(getVal('#cdRequestDelay')) || 0)
			];

			preferHtmlForDataImages = getChecked('#cdUseHtmlForData');
			suppressTocWithAnchors = noToc;
			requestDelayMs = requestDelaySec * 1000;

			let pageId;
			try { pageId = parseInput(input); } catch (err) { alert(err.message); return; }
			if (!/^\d+$/.test(pageId)) { alert('Could not determine Confluence page ID on this view.'); return; }

			try {
				setBusy(true, 'Fetching page…');
				const page = await fetchPage(pageId);
				const summary = {
					id: page.id,
					title: page.title || '',
					space: page.space?.key || '',
					version: page.version?.number || ''
				};

				const wantComments = commentsWhere !== 'none';
				const commentOpts = { where: commentsWhere, thread: threadDepth, includeResolved };
				const safeTitle = (page.title || `page-${page.id}`).replace(/[^\w.-]+/g, '_').slice(0, 120);

				if (format === 'markdown') {
					let md = await pageToMarkdown(page, embedImages);
					let comments;
					if (wantComments) {
						setStatus('Fetching comments…');
						comments = await fetchComments(pageId, commentOpts);
						if (comments) md += await commentsToMarkdown(comments, embedImages);
					}

					const filename = `${safeTitle}.${page.id}.md`;
					await saveFile(filename, md);
					summary.filename = filename;

					let childrenExported = 0;
					if (includeChildren) {
						let layer = [{ id: pageId, level: 0 }];
						const seen = new Set([String(pageId)]);

						while (layer.length) {
							const next = [];
							for (const node of layer) {
								if (node.level >= depth) continue;
								setStatus(`Fetching children at depth ${node.level + 1}…`);
								const kids = await fetchChildrenV1(node.id);

								for (const k of kids) {
									if (seen.has(String(k.id))) continue;
									seen.add(String(k.id));
									next.push({ id: k.id, level: node.level + 1 });

									const childPage = await fetchPage(k.id);
									let childMd = await pageToMarkdown(childPage, embedImages);
									if (wantComments) {
										const childComments = await fetchComments(k.id, commentOpts);
										if (childComments) childMd += await commentsToMarkdown(childComments, embedImages);
									}
									const childSafe = (childPage.title || `page-${childPage.id}`).replace(/[^\w.-]+/g, '_').slice(0, 120);
									await saveFile(`${childSafe}.${childPage.id}.md`, childMd);
									// Use configured delay between child exports (0 is allowed)
									if (requestDelayMs > 0) {
										await sleep(requestDelayMs);
									}
									childrenExported++;
								}
							}
							layer = next;
						}
						summary.children_exported = childrenExported;
					}

					if (wantComments && comments) summary.comments = { footer: comments.footer.length, inline: comments.inline.length };
					setBusy(false);
					showSummary(summary);
				} else { // JSON format
					const payload = {
						meta: { exportedAt: new Date().toISOString(), origin: location.origin, apiBaseV1: API.v1, apiBaseV2: API.v2 },
						page: {
							id: page.id, title: page.title, space: page.space, version: page.version, ancestors: page.ancestors, _links: page._links,
							body: { view: page.body?.view?.value || '', storage: page.body?.storage?.value || '', atlas_doc_format: page.body?.atlas_doc_format || null },
							labels: page.metadata?.labels || null
						}
					};

					let comments;
					if (wantComments) {
						setStatus('Fetching comments…');
						comments = await fetchComments(pageId, commentOpts);
						payload.comments = comments;
					}

					if (includeChildren) {
						setStatus('Fetching children…');
						const kids = await fetchChildrenV1(pageId);
						const children = [];
						for (const k of kids) {
							const full = await fetchPage(k.id);
							const child = {
								id: full.id, title: full.title, version: full.version, space: full.space, _links: full._links,
								body: { view: full.body?.view?.value || '', storage: full.body?.storage?.value || '', atlas_doc_format: full.body?.atlas_doc_format || null }
							};
							if (wantComments) child.comments = await fetchComments(k.id, commentOpts);
							children.push(child);
						}
						payload.children = children;
						summary.children_exported = payload.children.length;
					}

					const filename = `${safeTitle}.${page.id}.json`;
					await saveFile(filename, JSON.stringify(payload, null, 2));
					summary.filename = filename;

					if (wantComments && comments) summary.comments = { footer: comments.footer.length, inline: comments.inline.length };
					setBusy(false);
					showSummary(summary);
				}
			} catch (err) {
				setBusy(false);
				console.error('confDump error:', err);
				alert('confDump error: ' + (err?.message || String(err)));
			}
		};
	}

	window.confDump = function confDump() {
		try { buildModal(); } catch (e) { alert(e.message); }
	};

	confDump();
	console.log('Ready: confDump()');
})();

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_DEF = void 0;
exports.execute = execute;
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'search_images',
        description: 'Get free stock image URLs for a given subject from Lorem Picsum.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Subject or keywords for the image search.' },
                count: { type: 'number', description: 'Number of URLs to return (1-10, default 5).' },
            },
            required: ['query'],
        },
    },
};
function execute(args, _workspacePath) {
    const query = encodeURIComponent(String(args.query || 'nature'));
    const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);
    const urls = [];
    for (let i = 1; i <= count; i++) {
        urls.push(`https://picsum.photos/seed/${query}${i}/1400/900`);
    }
    return {
        success: true,
        output: [
            `Free image URLs for "${args.query}":`,
            ...urls.map((u, i) => `${i + 1}. ${u}`),
            '',
            'Usage: <img src="URL_HERE" alt="description" />',
        ].join('\n'),
    };
}
//# sourceMappingURL=index.js.map
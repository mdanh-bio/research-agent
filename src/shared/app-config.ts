// Single source of truth for project identity and external links. Shared by the main process
// (GitHub star-count fetch) and the renderer (every entry-point link). Keep this UI-free — no
// icons, no JSX — so both processes can import it and any screen reuses the same values.

const GITHUB_OWNER = 'mdanh-bio'
const GITHUB_REPO = 'research-agent'
const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`

export const APP = {
  name: 'Research Agent',
  githubOwner: GITHUB_OWNER,
  githubRepo: GITHUB_REPO,
  links: {
    website: GITHUB_REPO_URL,
    githubRepo: GITHUB_REPO_URL,
    githubReleases: `${GITHUB_REPO_URL}/releases`,
    githubApi: `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`,
    githubIssues: `${GITHUB_REPO_URL}/issues`,
    upstream: 'https://github.com/aipoch/open-science'
  },
  copyright: '© 2026 mdanh-bio and AIPOCH contributors.',
  update: {
    enabled: false,
    manifestUrl: `${GITHUB_REPO_URL}/releases/latest/download/version.json`,
    downloadPage: `${GITHUB_REPO_URL}/releases`
  }
} as const

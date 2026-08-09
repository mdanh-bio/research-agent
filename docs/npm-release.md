# Private CLI package verification

Research Agent's CLI/SDK package is `@mdanh-bio/research-agent`. It is private and is not published
to npm. The inherited source directory remains `packages/open-science` as a compatibility path; the
package manifest and root application manifest both set `private: true`.

The `publish-npm.yml` workflow is verification-only. It may inspect and upload a workflow artifact,
but it has no npm credentials, OIDC publishing permission, release job, or `npm publish` command.
Checkout credentials are not persisted, and both package-inspection paths use `npm pack
--ignore-scripts`.

Run the local gates with:

```bash
npm run test:private-package
npm run check:cli-package
npm run test:cli
```

Do not create npm release tags, add npm credentials, change either manifest to public, or introduce a
publish step without a separate owner-approved design and threat review. A future private
distribution mechanism must preserve the application's manual-update boundary and must be tested
independently from AIPOCH's public package/release channels.

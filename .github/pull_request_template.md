## Test guardrails checklist

- [ ] Gate A: `npm run check`
- [ ] Gate B: `npm run test:fast`
- [ ] Gate C (if applicable): `npm run test:smoke`
- [ ] Bug fixes include a regression test (red -> green)
- [ ] New features include at least 1 Gate B test (and a Gate C coverage point if it affects end-to-end flows)


import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  ssite: 'https://925963.github.io',
  base: '/atlassian-features',
  integrations: [
    starlight({
      title: 'Atlassian Cloud Features',
      description: 'Bijgehouden overzicht van alle Atlassian Cloud feature uitrolling — ontdubbeld, met aankondigings- en uitroldatums.',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
      },
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        replacesTitle: false,
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/rikdevalk/atlassian-features' },
      ],
      sidebar: [
        {
          label: 'Overview',
          items: [
            { label: 'All Features', link: '/features/' },
            { label: 'New This Week', link: '/new-this-week/' },
            { label: 'Coming Soon', link: '/coming-soon/' },
            { label: 'Rolling Out', link: '/rolling-out/' },
            { label: 'Completed', link: '/completed/' },
          ],
        },
        {
          label: 'By Product',
          autogenerate: { directory: 'products' },
        },
        {
          label: 'About',
          items: [
            { label: 'How this works', link: '/about/' },
          ],
        },
      ],
      customCss: ['./src/styles/custom.css'],
      head: [
        {
          tag: 'meta',
          attrs: { name: 'author', content: 'Rik de Valk / Brainboss' },
        },
      ],
    }),
  ],
});

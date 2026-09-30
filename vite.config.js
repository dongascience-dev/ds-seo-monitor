import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 상대 경로로 빌드한다. GitHub Pages 는 레포 이름이 경로에 붙어
  // (/ds-seo-monitor/) 절대 경로로 빌드하면 자산을 못 찾는다. 상대 경로면
  // 사용자 페이지·프로젝트 페이지·로컬 preview 어디서든 그대로 뜬다.
  base: './',
  build: {
    outDir: 'dist',
    // public/data/*.json 은 수집 워크플로가 커밋하는 결과물이다. 번들에 넣지 않고
    // public 으로 복사만 되므로, 데이터만 갱신될 때 재빌드가 필요 없다.
    assetsDir: 'assets',
  },
});

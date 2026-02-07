import { ParsedAddress } from '../types';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 등기부등본 조회 서비스
 *
 * MVP: 실제 API 연동 전 Mock 구현
 * TODO: 실제 등기소 API 또는 서드파티 API (틸로, 바로빌 등) 연동
 */
export class RegistryService {
  /**
   * 등기부등본 조회 및 PDF 생성
   */
  async fetchRegistry(address: ParsedAddress): Promise<string> {
    console.log('등기부등본 조회 시작:', address.fullAddress);

    // TODO: 실제 API 호출 구현
    // 현재는 Mock PDF 파일 생성
    await this.simulateAPICall();

    const mockPdfPath = await this.generateMockPDF(address);

    return mockPdfPath;
  }

  /**
   * API 호출 시뮬레이션 (지연 시간)
   */
  private async simulateAPICall(): Promise<void> {
    return new Promise(resolve => {
      setTimeout(resolve, 2000); // 2초 지연
    });
  }

  /**
   * Mock PDF 파일 생성
   */
  private async generateMockPDF(address: ParsedAddress): Promise<string> {
    const tempDir = process.env.TEMP_FILE_PATH || './temp';

    // temp 디렉토리가 없으면 생성
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const fileName = `등기부등본_${address.eupmyeondong}_${Date.now()}.pdf`;
    const filePath = path.join(tempDir, fileName);

    // Mock PDF 내용 (실제로는 API에서 받은 데이터로 PDF 생성)
    const mockContent = `
등기부등본 (Mock)
====================
주소: ${address.fullAddress}
발급일시: ${new Date().toLocaleString('ko-KR')}
====================
※ 이것은 테스트용 Mock 파일입니다.
※ 실제 등기소 API 연동 후 실제 데이터로 대체됩니다.
    `.trim();

    fs.writeFileSync(filePath, mockContent, 'utf-8');

    console.log('Mock PDF 생성:', filePath);
    return filePath;
  }

  /**
   * 파일 정리 (보존 기간 초과 파일 삭제)
   */
  async cleanupOldFiles(): Promise<void> {
    const retentionDays = parseInt(process.env.FILE_RETENTION_DAYS || '30');
    const tempDir = process.env.TEMP_FILE_PATH || './temp';

    if (!fs.existsSync(tempDir)) {
      return;
    }

    const now = Date.now();
    const files = fs.readdirSync(tempDir);

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      const stats = fs.statSync(filePath);
      const fileAge = (now - stats.mtimeMs) / (1000 * 60 * 60 * 24); // 일 단위

      if (fileAge > retentionDays) {
        fs.unlinkSync(filePath);
        console.log(`파일 삭제 (보존 기간 초과):`, file);
      }
    }
  }
}

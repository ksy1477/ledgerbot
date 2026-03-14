import { RegistryService } from './registryService';
import { TilkoApiService } from './tilkoApiService';
import { ParsedAddress } from '../types';

/**
 * 통합 등기부등본 서비스
 *
 * Mock API 또는 실제 Tilko API 2단계 프로세스:
 * 1. TilkoApiService.searchPropertyPin: 주소 → 부동산 고유번호(PIN) 조회 (20포인트)
 * 2. TilkoApiService.fetchRegistry: PIN → 등기부등본 조회 (100포인트)
 */
export class UnifiedRegistryService {
  private service: RegistryService | TilkoApiService;

  constructor() {
    const useMock = process.env.USE_MOCK_API === 'true';

    if (useMock) {
      console.log('🧪 Mock API 모드로 시작합니다.');
      this.service = new RegistryService();
    } else {
      console.log('🔗 Tilko 실제 API 모드로 시작합니다.');
      this.service = new TilkoApiService();
    }
  }

  /**
   * 등기부등본 조회 (2단계 프로세스)
   */
  async fetchRegistry(address: ParsedAddress): Promise<{ filePath: string; pointBalance: number | null }> {
    // Mock 모드인 경우 바로 Mock 서비스 호출
    if (this.service instanceof RegistryService) {
      const filePath = await this.service.fetchRegistry(address);
      return { filePath, pointBalance: null };
    }

    // 실제 API 모드: 2단계 프로세스
    const tilkoService = this.service as TilkoApiService;

    // 1단계: 주소 → 부동산 고유번호(PIN) 조회 (Tilko 주소 검색 API, 20포인트)
    // Tilko API 일시적 장애 대비 최대 2회 시도
    let pin: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`📍 1단계: 주소 검색 중... (시도 ${attempt}/2)`);
      try {
        pin = await tilkoService.searchPropertyPin(address);
        if (pin) break;
      } catch (error: any) {
        console.error(`❌ 주소 검색 시도 ${attempt} 실패:`, error.message);
        if (attempt < 2) {
          console.log('⏳ 5초 후 재시도...');
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }

    if (!pin) {
      throw new Error('주소로 부동산 고유번호를 찾을 수 없습니다. 시/도, 시/군/구를 포함하여 다시 입력해주세요.');
    }

    console.log(`✅ 부동산 고유번호(PIN) 조회 성공: ${pin}`);

    // 2단계: PIN → 등기부등본 조회 (Tilko 등기부등본 API, 100포인트)
    // Tilko API 타임아웃 대비 최대 2회 시도
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`📄 2단계: 등기부등본 조회 중... (시도 ${attempt}/2)`);
      try {
        return await tilkoService.fetchRegistry(address, pin);
      } catch (error: any) {
        console.error(`❌ 등기부등본 조회 시도 ${attempt} 실패:`, error.message);
        if (attempt < 2) {
          console.log('⏳ 10초 후 재시도...');
          await new Promise(resolve => setTimeout(resolve, 10000));
        } else {
          throw error;
        }
      }
    }
    // TypeScript를 위한 unreachable 코드
    throw new Error('등기부등본 조회 실패: 최대 시도 횟수 초과');
  }

  /**
   * 서비스 타입 확인
   */
  getServiceType(): string {
    return this.service instanceof TilkoApiService ? 'Tilko API (2-step)' : 'Mock API';
  }
}

export { RegistryService, TilkoApiService };
export { PublicDataApiService } from './publicDataApiService';
export { TilkoBuildingService } from './tilkoBuildingService';
export { UnifiedBuildingService } from './unifiedBuildingService';

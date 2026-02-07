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
  async fetchRegistry(address: ParsedAddress): Promise<string> {
    // Mock 모드인 경우 바로 Mock 서비스 호출
    if (this.service instanceof RegistryService) {
      return this.service.fetchRegistry(address);
    }

    // 실제 API 모드: 2단계 프로세스
    const tilkoService = this.service as TilkoApiService;

    // 1단계: 주소 → 부동산 고유번호(PIN) 조회 (Tilko 주소 검색 API, 20포인트)
    let pin: string | null = null;

    try {
      console.log('📍 1단계: 주소 검색 중...');
      pin = await tilkoService.searchPropertyPin(address);

      if (pin) {
        console.log(`✅ 부동산 고유번호(PIN) 조회 성공: ${pin}`);
      } else {
        console.warn('⚠️  부동산 고유번호를 찾을 수 없습니다. 환경 변수의 PIN을 사용합니다.');
      }
    } catch (error: any) {
      console.error('❌ 주소 검색 실패:', error.message);
      console.warn('⚠️  환경 변수의 PIN 값을 사용합니다.');
    }

    // 2단계: PIN → 등기부등본 조회 (Tilko 등기부등본 API, 100포인트)
    console.log('📄 2단계: 등기부등본 조회 중...');
    return tilkoService.fetchRegistry(address, pin || undefined);
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

# OFT 툴 개발 참고 문서

조사일: 2026-09-06 (Asia/Seoul)

이 문서는 사용자의 요구사항, 참고 사이트에서 관찰한 사실, 공식 문서에 근거한 기술 사항, 향후 구현 제안을 구분해 기록한다. 구현 범위와 기본값은 아래 제안을 토대로 다음 단계에서 확정한다.

후속 결정: 초기 환경은 **로컬 개인용 대시보드 / BSC ↔ Ethereum / Rabby 브라우저 확장**으로 확정됐다. 사용자 지갑으로 승인·전송하는 기능까지 목표로 한다. 최신 구현 단계와 열린 선택은 [아키텍처와 마일스톤](ARCHITECTURE_MILESTONES.md)을 기준으로 한다.

RPC 정책도 사용자 확정: 무료·공개 RPC를 기본 사용한다. 사용 불가 시 **RPC 오류**를 명시하고 출발·도착 체인별 RPC 직접 입력과 재시도를 제공한다. 유료 RPC 가입을 필수로 요구하지 않는다. RPC 장애와 컨트랙트 revert·브릿지 미발견·메타데이터/Scan API 장애를 구분한다.

사용 목적 재확인: 첫 버전은 프론트 미지원 일반 V2 OFT·OFTAdapter 경로에 집중한다. Stargate 자체 Pool 경로 지원은 초기 범위에서 제외한다. 아래 Pool/Taxi 관련 조사 내용은 구현 차이를 구분하기 위한 참고 자료이며 초기 구현 요구사항이 아니다. OFTAdapter가 보관하는 토큰 잔액을 Stargate 자체 유동성 Pool과 혼동하지 않는다.

## 1. 사용자가 해결하려는 문제

신생 토큰의 OFT 전송 경로가 온체인에 구성되어 있어도 Stargate 프론트에서 아직 선택할 수 없는 경우를 지원한다. 현재 탐색기의 Read/Write Contract에서 사람이 주소를 찾고 파라미터를 입력하는 과정을 일부 자동화한다.

주요 사용 흐름:

1. 출발 네트워크, 토큰 CA, 도착 네트워크 입력.
2. OFT 또는 어댑터 후보를 찾고 해당 방향의 경로를 확인.
3. 수량과 송신·수신 주소를 추가하면 전송 조건과 수수료를 확인.
4. 검증 결과와 함께 탐색기용 파라미터 또는 지갑용 트랜잭션을 준비.
5. 사용자가 실행한 전송의 도착 상태를 추적.

프론트 미표시 원인을 항상 업데이트 지연으로 단정하지 않는다. 토큰 주소와 체인의 지원 여부, 메시지 설정, 프로젝트별 제한을 별도로 판별하는 것이 목표다.

### 사용자가 추가로 설명한 수동 작업과 시험 방식

- CoinMarketCap에서 토큰을 찾고 해당 체인 탐색기의 Contract/Write Contract에서 `send`를 확인한다.
- 기존 성공 거래를 [BscScan Input Data Decoder](https://bscscan.com/inputdatadecoder)에 넣어 경로와 인자 구성의 참고 자료를 얻는다.
- 목적지 EID, 수신 주소, 수량, 최소 수령량, 옵션, 수수료와 환불 주소를 채워 지갑으로 실행한다. 실제 구현에는 이 문서의 단위 환산·현재 견적 규칙을 적용한다.
- **0개 테스트는 필수 절차가 아니다.** 대시보드 구현 후 **사용자가 직접 소액으로 시험 전송**할 계획이다.
- 소액 테스트도 출발 성공과 목적지 토큰 수령을 구분해 확인할 수 있도록 대시보드에서 양쪽 증거를 제공한다.

사용자가 제공한 실제 참고 경로는 DOS의 BSC → Ethereum이다. 원시 입력과 구조화된 결과는 [사례 JSON](../tests/fixtures/dos-bsc-ethereum.json)에 둔다. 이 fixture의 지갑 주소·거래 해시·블록 번호·수량·시각·가스는 모두 합성 값이며, 공개 컨트랙트 주소만 실제 값이다.

## 2. 참고 사이트 확인 기록

[지인의 파라미터 생성기](https://stargate-bridge-params.vercel.app/)의 화면, 검색·생성 동작, 공개 HTML의 생성 처리 코드를 확인했다. 저장소 전체나 서버 구현을 감사한 것은 아니다.

- 직접 주소 입력과 메타데이터 검색을 제공한다. 토큰·어댑터 주소, 소수점, 승인 관련 정보를 표시한다.
- 체인/EID 선택, 커스텀 RPC, 수량·슬리피지, 실행 가스·native drop 설정을 제공한다.
- 개별 필드와 tuple 복사, 트랜잭션 상태 조회가 있다.
- 검색에는 사이트 내 메타데이터 스냅샷과 활동 기반 어댑터 인덱스도 사용한다.

#### CA 자동 입력과 `Pool 컨트랙트` 표기의 의미

2026-09-06 확인한 공개 HTML에서 `pool` 필드는 실제 호출 대상 주소를 보관한다. 일반 OFT 자체 주소, OFTAdapter 주소, Stargate 자체 Pool 주소를 모두 이 필드에 넣을 수 있으므로 화면의 `Pool`이라는 이름만으로 Stargate 유동성 Pool이라고 판단하지 않는다.

- 직접 입력의 `lookupByTokenAddress()`는 체인별 내장 주소 매핑 → 이미 알고 있는 풀 후보들의 `token()` 비교 → 입력 주소의 `endpoint()` 조회를 통한 자체 OFT 후보 탐지 순서다. 모든 온체인 컨트랙트를 검색하는 구조가 아니다.
- 이 코드에는 RPC가 없거나 해당 체인의 기존 후보 목록이 비었을 때 자체 OFT 탐지 전에 반환하는 분기도 있다. 따라서 검색 결과 없음과 경로 없음은 구분해야 한다.
- 별도의 Metadata 조회는 `oft-snapshot.json`과 `adapter-activity-index.json`을 읽고, 입력 CA를 배포 주소 또는 내부 토큰 주소와 비교한다.
- 예를 들어 일반 ERC-20 A와 별도 어댑터 B가 있을 때, B가 검색 자료에 없고 A 자체에 OFT 기능도 없다면 A 입력만으로 B를 발견하지 못할 수 있다. B의 존재나 현재 경로의 정상 여부를 부정하는 결과는 아니다.
- RPC/API 장애도 자동 탐색 실패의 원인이 될 수 있다. 후보가 여러 개라 선택이 필요한 상태와도 구분한다.

사용자는 CA 자동 탐색과 실패 시 브릿지 주소 직접 입력·성공 거래 해시로 보완하는 흐름을 수락했으며, **Pool 컨트랙트를 찾지 못했음을 명시**하도록 요구했다. 결과가 없으면 `Pool 컨트랙트를 찾지 못했습니다`를 표시하고, 브릿지 불가능 판정과 구분한다. RPC 장애로 조회를 끝내지 못하면 `RPC 오류 — [네트워크] Pool 컨트랙트를 확인하지 못했습니다`와 재시도·RPC 직접 입력을 표시한다. 메타데이터 API 장애는 별도 서비스 조회 오류로 표시한다. 처음부터 매번 사용자가 주소를 찾아야 한다는 의미가 아니다. 세부 상태와 완료 조건은 M2에 반영했다.

- 공개 USDT0 배포를 선택해 Ethereum → Arbitrum, 수량 1, 테스트 주소 `0x1111111111111111111111111111111111111111`로 파라미터 생성과 승인 필요 표시를 확인했다. 서명·승인·전송은 하지 않았다.
- 확인한 생성 코드에서는 출발측 `peers`, 잔액·allowance, `enforcedOptions`, `quoteSend`를 조회한다. `quoteOFT`와 실제 `send` 시뮬레이션은 수행하지 않는다.
- 일부 조회 오류는 무시되며, 승인 판단은 allowance 비교를 사용한다. 같은 오류 selector에 대한 화면 안내와 코드 설명이 서로 다른 부분도 있다.

공개 HTML SHA-256: `5a3cf8874a30e3e95ec849f81f102d47fbcd9183b60090bea604d2509bd42d74`.

이 기록은 조사 시점의 관찰이다. 생성된 당시 수수료는 이후 전송에 재사용하지 않는다.

## 3. 우리 툴에 적용할 설계 방향

아래는 구현 제안이다.

- 검색과 직접 입력을 모두 제공한다. API에 없는 토큰을 다루는 기능이 제품의 핵심이다.
- 일반 사용자 화면의 입력값은 체인·CA·수량·수신 주소로 줄이고, 실제 브릿지 컨트랙트와 옵션은 상세 영역에서 보여준다.
- 주소 이름은 `토큰 컨트랙트`, `브릿지 컨트랙트(OFT/Adapter/Pool)`, `목적지 토큰`으로 구분한다.
- 송신자, 토큰 수신자, 수수료 환불 주소, native drop 수신자를 데이터 모델에서 구분한다. 기본값이 같더라도 별도 역할이다.
- `조회됨`, `경로 확인됨`, `견적 조회됨`, `출발 체인 시뮬레이션 통과`를 별개 결과로 표시한다.
- 검증 실패의 원인을 사람이 이해할 수 있게 설명하고, 추가 입력·RPC 변경·승인·수량 조정 등 가능한 다음 행동을 표시한다.
- 기술적으로 호출 가능한지와 해당 프로젝트의 의도된 배포인지에 대한 근거를 따로 표시한다. 메타데이터와 `token()` 일치만으로 공식성을 보장하지 않는다.
- 내부 주소, 원시 정수, calldata를 복사할 수 있게 하되 일반 화면에는 금액과 네트워크 이름을 우선 표시한다.

## 4. CA로 찾을 수 있는 범위

CA는 출발 체인과 함께 식별한다. 하나의 ERC-20이 여러 어댑터와 연결될 수 있으므로, 탐색 결과는 단일 주소 대신 후보 목록으로 취급한다.

권장 탐색 순서:

1. 입력 주소에 컨트랙트 코드가 있는지 확인한다.
2. OFT 인터페이스에 해당하는 읽기 호출을 시도하고 반환값을 검증한다.
3. 일반 ERC-20이면 공식 배포 메타데이터에서 연결된 브릿지 컨트랙트를 찾는다.
4. 없으면 프로젝트가 공개한 배포 정보와 검증된 전송 이력을 후보 발견에 활용한다.
5. 자동 발견이 안 되면 미발견을 명시하고 브릿지 컨트랙트 주소 직접 입력 또는 성공 거래 해시에서 후보 추출을 제공한다.
6. 발견 경로에 관계없이 해당 주소의 토큰 연결과 목적지 경로를 다시 온체인 조회한다.

토큰 CA → 어댑터 주소를 모든 토큰에 대해 역조회하는 보편적인 ERC-20 함수는 전제할 수 없다. 어댑터 패턴에서는 원래 토큰이 LayerZero 연결 정보를 알 필요가 없기 때문이다. 검색 결과가 없을 때는 `확인 불가`로 반환한다. [OFT 기술 설명](https://docs.layerzero.network/v2/concepts/technical-reference/oft-reference)

과거 성공 거래는 후보 발견의 증거다. 현재 peer, 구현, 설정, 전송 한도가 유지된다는 증거로 사용하지 않는다. 임의의 상대 컨트랙트를 자동 선택하거나 peer를 변경하는 기능은 필요하지 않다.

## 5. 데이터 소스와 사용 목적

| 데이터 | 공식 진입점 | 사용 방식 |
|---|---|---|
| 네트워크, EID, RPC, Endpoint | [Endpoint metadata JSON](https://metadata.layerzero-api.com/v1/metadata) | 체인 레지스트리의 입력 자료. 실제 RPC의 체인과 온체인 배포를 확인 |
| OFT 생태계 배포 | [OFT deployment JSON](https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list) | OFT·어댑터 후보 발견. 이름만으로 경로 확정 금지 |
| Stargate V2 자산 배포 | [Stargate V2 metadata JSON](https://mainnet.stargate-api.com/v1/metadata?version=v2) | Stargate 관리 자산 식별과 구현별 분기 |
| 전송 API 등록 토큰·목적지 | [Value Transfer tokens API](https://transfer.layerzero-api.com/v1/tokens) | 목록 보강 및 지원 경로 참고. 미등록 토큰의 직접 검사와 독립적으로 사용 |
| 크로스체인 메시지 | [LayerZero Scan API 문서](https://docs.layerzero.network/v2/tools/layerzeroscan/api) | 출발 tx hash 또는 GUID로 전송 진행 상태 조회 |
| 검증된 소스와 ABI | 프로젝트 공식 배포 문서, 해당 체인의 탐색기 | 프록시 구현, 커스텀 제한, 오류 ABI 등을 확인 |

처음 세 JSON의 용도는 [Endpoint Metadata 문서](https://docs.layerzero.network/v2/tools/endpoint-metadata)와 [OFT Ecosystem & Stargate Assets](https://docs.layerzero.network/v2/deployments/oft-ecosystem-stargate-assets)에 근거한다. 이름, URL, 스키마와 가용성은 구현 시 재확인한다. 특히 `experiment` 경로는 고정 스키마로 가정하지 않는다.

Value Transfer API는 출발 `chainKey`와 토큰 주소를 함께 전달해 목적지 목록을 조회할 수 있다. API 기반 견적에는 인증이 필요할 수 있으므로 공식 문서의 `x-api-key` 요구사항을 확인한다. API가 반환하는 실행 단계는 별도 라우터·spender를 사용할 수 있어 직접 OFT 호출의 승인 규칙을 그대로 적용하면 안 된다. 초기 설계에서는 목록 보강 용도로 제한하는 것을 제안한다. [Value Transfer API Quickstart](https://docs.layerzero.network/v2/developers/value-transfer-api/quickstart)

데이터 제공자별로 수집 시각, 원본 출처, 스키마 버전, 전체/부분 수집 여부를 저장한다. 페이지네이션, 타임아웃, 오류, 캐시 만료를 처리하고, 마지막 정상 목록이 오래됐다는 사실을 표시한다. 친구 사이트의 스냅샷을 우리 서비스의 영구 데이터 원본으로 삼지는 않는다.

## 6. 사전 검증 절차

### 6.1 입력과 구현 식별

| 항목 | 제안하는 검사 |
|---|---|
| 네트워크 | 출발·도착이 서로 다른지, mainnet/testnet이 일치하는지, 현재 지원 VM인지 |
| RPC | `eth_chainId`가 선택한 체인과 일치하는지. 출발과 도착을 각각 확인 |
| 주소 | 형식, 체크섬 정책, 코드 존재, 프록시 여부 확인 |
| OFT 인터페이스 | `oftVersion()`, `token()`, `approvalRequired()`, `sharedDecimals()` 반환값 확인 |
| 토큰 연결 | 어댑터의 `token()`이 사용자가 선택한 토큰과 일치하는지 |
| 소수점 | 실제 토큰의 `decimals()` 확인. 조회 실패를 18로 조용히 대체하지 않음 |
| 특수 구현 | Stargate 타입, 네이티브 자산 어댑터, 커스텀 전송 제약을 별도 분기로 분류 |

함수 하나의 성공으로 표준 준수나 공식성을 확정하지 않는다. 미지원 ABI와 RPC 장애도 구분한다. 이전 OFT 버전이나 커스텀 구현을 발견하면 지원 범위를 표시하고 일반 V2 로직으로 강제 처리하지 않는다.

인터페이스와 승인 여부 조회 함수의 근거: [공식 IOFT 인터페이스](https://github.com/LayerZero-Labs/devtools/blob/main/packages/oft-evm/contracts/interfaces/IOFT.sol).

### 6.2 출발 → 도착 경로

표준 V2 OFT 경로에는 다음 검사를 제안한다. Stargate 등 별도 메시징 구조는 해당 구현에 맞는 검사기를 사용한다.

1. 출발 OFT의 `peers(dstEid)`가 목적지 브릿지 컨트랙트를 가리키는지 확인.
2. 도착 컨트랙트의 `peers(srcEid)`가 출발 OFT를 신뢰하는지 확인.
3. 목적지 코드, 토큰 연결, OFT 메시지 버전 호환성을 확인.
4. 실제 Endpoint와 체인 EID를 확인.
5. 출발 송신 라이브러리와 도착 수신 라이브러리, effective DVN·confirmation 설정, Executor를 확인.
6. 출발 설정으로 목적지의 검증 요구사항을 충족하는지 검사. 차단 라이브러리나 비활성 구성을 발견하면 원인을 표시.

양쪽 peer 조회는 한 방향 메시지의 송수신 신뢰를 확인하는 절차다. 역방향 전송까지 검증했다는 뜻은 아니다. [OFT 연결 설정](https://docs.layerzero.network/v2/developers/evm/oft/quickstart)

라이브러리는 `getSendLibrary`, `getReceiveLibrary`, 설정은 `getConfig` 등을 이용해 기본값 상속까지 반영한다. 기본값과 주소가 같다는 이유만으로 명시적 설정 여부를 판단하지 않는다. 검사 도구는 설정을 읽고 문제를 설명하며 운영자 설정을 변경하지 않는다. [DVN·Executor 설정 문서](https://docs.layerzero.network/v2/developers/evm/configuration/dvn-executor-config)

EID와 EVM chain ID는 별도 필드로 보관한다. EID의 임의 숫자 범위를 지원 여부 판정에 사용하지 않는다. [공식 배포 문서](https://docs.layerzero.network/v2/deployments/deployed-contracts)

### 6.3 수량, 승인, 실행 준비

권장 순서:

1. 문자열 수량을 정수로 변환하고 소수점·범위를 검사한다.
2. 구현에 맞게 `quoteOFT`를 호출해 수령량과 한도·수수료 정보를 읽는다.
3. 사용자 슬리피지를 반영한 최종 최소 수령량과 실행 옵션을 만든다.
4. 최종 파라미터로 `quoteSend(..., false)`를 호출한다.
5. 실제 송신자 기준 토큰 잔액과 `approvalRequired()`를 확인하고, 승인 필요 시 allowance를 비교한다.
6. 토큰 구현별로 필요한 승인 절차를 준비한다. 기본 제안은 필요한 금액만 승인하며, 0으로 초기화해야 하는 토큰은 별도 지원한다.
7. `send`를 송신자 주소·최종 인자·value로 출발 체인에서 시뮬레이션하고 revert를 해석한다.
8. 트랜잭션 가스 비용과 value를 감당할 네이티브 잔액을 확인한다. 체인별 추가 수수료 모델도 고려한다.

승인 필요 여부는 allowance가 0이라는 사실만으로 결정하지 않는다. 승인 대상 토큰과 spender는 실제 호출 구조를 기준으로 정한다. 직접 OFT 호출의 함수 역할은 [IOFT](https://github.com/LayerZero-Labs/devtools/blob/main/packages/oft-evm/contracts/interfaces/IOFT.sol), 기본 어댑터 승인 흐름은 [OFT 사용 문서](https://docs.layerzero.network/v2/developers/evm/oft/quickstart)를 참고한다.

승인 전에는 `send` 시뮬레이션이 allowance 부족으로 실패할 수 있다. 이 경우 경로 실패와 승인 대기를 분리한다. 로컬 포크나 state override로 승인 후 상황을 가정했다면 반드시 가정한 상태임을 표시한다. 실제 승인 후에는 현재 상태에서 다시 검사한다. [viem simulateContract](https://viem.sh/docs/contract/simulateContract)

pause, rate limit, 민팅 권한, 블랙리스트, 담보 잔액 등은 구현별 검사다. 공통 `paused()`나 한도 함수가 모든 OFT에 있다고 가정하지 않는다. 모르는 커스텀 제한은 `확인하지 못한 항목`으로 남긴다. [OFT 확장 구조](https://docs.layerzero.network/v2/concepts/technical-reference/oft-reference)

## 7. 파라미터와 금액 처리 규칙

### 7.1 출력해야 할 값

| 필드 | 규칙 |
|---|---|
| 트랜잭션 `chainId` | 출발 EVM 체인 ID |
| 트랜잭션 `to` | 출발 OFT/Adapter/Pool 주소 |
| `dstEid` | 도착 LayerZero Endpoint ID, `uint32` |
| `to` in SendParam | 토큰 수신 주소, `bytes32`. EVM 주소는 왼쪽 0 패딩 |
| `amountLD` | 출발 로컬 소수점 단위 전송량, `uint256` |
| `minAmountLD` | 해당 구현·견적의 LD 기준 최소 수령량, `uint256` |
| `extraOptions` | 실행 옵션 bytes |
| `composeMsg` | 일반 전송은 빈 bytes `0x` |
| `oftCmd` | 일반 OFT는 기본 빈 bytes. Stargate는 전송 모드 의미를 확인 |
| `nativeFee`, `lzTokenFee` | 최종 `quoteSend` 반환값 |
| `_refundAddress` | 출발 체인에서 초과 수수료를 돌려받을 주소 |
| 트랜잭션 `value` | 메시징 수수료와 해당 자산 구현이 요구하는 네이티브 원금 |
| calldata | 실제 구현 ABI로 인코딩한 전체 호출 데이터 |

tuple 순서와 의미는 [IOFT](https://github.com/LayerZero-Labs/devtools/blob/main/packages/oft-evm/contracts/interfaces/IOFT.sol)를 기준으로 한다. UI에서는 트랜잭션의 `to`와 SendParam의 `to`를 반드시 다른 이름으로 설명한다.

### 7.2 정수, dust, 최소 수령량

금액은 입력부터 계산·JSON 저장까지 문자열과 `bigint`를 사용한다. 소수점 수량을 JavaScript `Number`로 왕복하지 않는다. 슬리피지도 정수 bps 등 명시된 정밀도로 처리한다.

표준 OFT의 LD/SD 변환과 dust를 반영한다. 예를 들어 localDecimals=18, sharedDecimals=6이면 입력 `1.123456789` 중 표준 전송량은 `1.123456`, 남는 양은 `0.000000789`이다. [OFT 소수점 변환](https://docs.layerzero.network/v2/concepts/technical-reference/oft-reference)

최소 수령량 제안은 다음과 같다.

```text
expectedReceivedLD = quoteOFT로 확인한 수령량
minAmountLD = floor(expectedReceivedLD × (10_000 - slippageBps) / 10_000)
```

단순 입력량에서 슬리피지만 빼면 dust나 토큰 수수료 때문에 실패할 수 있다. 위 식은 해당 구현의 견적이 유효하다는 전제의 정책이며, 실제 ABI·단위·경계값을 검증한다. dust가 남는 경우 입력량, 실제 차감량, 예상 수령량을 따로 표시한다.

표준 OFT 견적의 LD 값은 출발 로컬 단위로 해석하고, 목적지 표시 금액은 sharedDecimals와 목적지 localDecimals를 이용해 변환한다. 원시 `amountReceivedLD`를 목적지 decimals로 바로 표시하지 않는다.

### 7.3 OFT와 Stargate의 차이

Stargate V2는 IOFT를 확장하며 `sendToken`도 제공한다. Taxi는 빈 `oftCmd`, Bus는 다른 값을 사용한다. 이는 구현 차이를 설명하는 참고 자료다. 이후 사용자 사용 목적에 맞춰 초기 범위는 일반 OFT·OFTAdapter로 좁혔고 Stargate 자체 경로는 제외했다.

Stargate Taxi는 기본 수신 실행 가스를 자체 처리하므로 일반 OFT용 LZ_RECEIVE 옵션을 그대로 추가하지 않는다. 네이티브 자산 Stargate Pool에서는 수수료에 전송 원금을 더한 value가 필요하다. ERC-20과 같은 식으로 처리하면 안 된다. [Stargate 전송 문서](https://docs.stargate.finance/developers/protocol-docs/transfer)

그 외 NativeOFTAdapter, 대체 수수료 토큰을 쓰는 체인은 별도 구현 지원이 확인되기 전까지 실행 준비 완료로 표시하지 않는다. 모든 체인의 네이티브 통화를 ETH, 18 decimals로 가정하지 않는다.

## 8. 실행 옵션과 수수료

일반 OFT는 해당 목적지·메시지 유형의 enforced 옵션을 읽고 caller 옵션과 합쳐진 결과를 확인한다. 단순 전송의 메시지 유형은 통상 SEND=1이지만 커스텀 구현은 확인이 필요하다.

빈 값이 아닌 enforced 옵션이 있다는 이유만으로 충분한 LZ_RECEIVE 가스가 설정됐다고 판정하지 않는다. 같은 종류의 옵션은 합산될 수 있으므로 중복 추가를 확인한다. 가스 프리셋은 추천값이며 성공 보장이 아니다.

OptionsBuilder 또는 공식 SDK를 사용하고, 지원 버전의 인코딩과 왕복 디코딩을 검증한다. native drop은 수신 실행 가스와 구분하고 목적지 네이티브 단위와 수신 주소를 확인한다. Executor의 목적지 native cap도 확인한다. [실행 옵션 문서](https://docs.layerzero.network/v2/developers/evm/configuration/options)

출발 트랜잭션의 gas limit, 목적지 실행 gas units, 메시징 `nativeFee`, 토큰 수수료, native drop 금액은 다른 값이다. 비용 화면에서는 합산 근거와 통화를 보여준다.

견적에는 조회 시각, 출발 블록, 입력값의 해시를 저장한다. 체인·주소·수량·옵션이 바뀌면 이전 견적과 검증을 폐기한다. 실행 직전 재견적하며, 저장된 파라미터를 다시 열어도 최신 비용을 확인한다. [견적 갱신 원칙](https://docs.layerzero.network/v2/developers/evm/oft/quickstart)

## 9. 결과 상태와 진단

앱 내부 검사 항목은 `PASS / FAIL / UNKNOWN / NOT_APPLICABLE`로 구분하고 근거를 붙이는 것을 제안한다.

| 화면 결과 | 의미 |
|---|---|
| 후보 발견 | 브릿지 컨트랙트 후보를 찾음. 경로 검증 전 |
| 경로 검증 통과 | 구현에 필요한 양쪽 경로 검사를 통과. 수량·지갑 조건은 별도 |
| 전송 준비 필요 | 승인, 잔액, 옵션 등 해결할 조건이 있음 |
| 사전 검증 통과 | 정해진 범위의 경로·금액 검증과 현재 출발 체인 시뮬레이션을 통과 |
| 현재 조건에서 불가 | peer 미설정, 한도 초과 등 구체적인 차단 사유가 확인됨 |
| 확인 불가 | RPC 실패, 어댑터 미발견, 미지원 구현 등으로 필요한 근거가 부족함 |

필수 검사에 UNKNOWN이 있으면 전체 통과로 승격하지 않는다. RPC 오류는 경로 미지원으로 단정하지 않고, 재시도 가능한 오류와 컨트랙트 revert를 분리한다.

오류 진단 제안:

- 가능한 경우 해당 구현과 하위 라이브러리의 ABI로 revert data를 디코딩한다.
- selector, 오류명·인자, 발생한 검사 단계, 사람이 읽을 설명을 함께 보관한다.
- 슬리피지, 메시지 옵션, peer, allowance, 잔액 문제에 각각 다른 해결책을 제시한다.
- 모르는 selector는 원인을 추측해 확정하지 않는다.

사전 검증은 관찰 시점의 준비 상태에 대한 판단이다. 출발 체인 시뮬레이션은 미래 목적지 상태나 DVN/Executor의 이후 동작까지 실행하지 않는다. 목적지 검증 실패, 실행 가스 부족, 설정 변경, 담보·한도 변화 가능성은 검증 범위 설명에 반영한다. [시뮬레이션 범위](https://viem.sh/docs/contract/simulateContract), [크로스체인 실행 단계](https://docs.layerzero.network/v2/concepts/troubleshooting/debugging-messages)

## 10. 전송 후 추적

직접 OFT 전송은 LayerZero Scan의 `GET /v1/messages/tx/{txHash}` 또는 GUID 조회를 활용한다. tx 하나에 여러 메시지가 있을 수 있으므로 배열 전체를 처리하고 출발·도착 EID와 OApp 주소로 대상 메시지를 구분한다.

출발 확인, DVN 검증, 목적지 실행을 별도로 표시한다. native drop과 compose를 지원한다면 각각의 상태도 분리한다. `INFLIGHT`, `CONFIRMING`, `DELIVERED`, `FAILED`, `BLOCKED` 등의 실제 API 상태를 보존하고, 모르는 새 상태를 성공으로 처리하지 않는다. [Scan API 문서](https://docs.layerzero.network/v2/tools/layerzeroscan/api)

인덱싱 지연과 조회 실패를 전송 실패로 오인하지 않는다. 각 체인의 탐색기 URL은 체인 레지스트리에서 가져온다. 가능한 경우 목적지의 OFTReceived 등 구현별 수령 증거와 실제 수신 토큰을 확인한다.

이 절은 향후 툴의 추적 기능 설계이며, 현재 대화에서 주기적 모니터링이나 자동 실행을 설정한 것은 아니다.

## 11. 권장 구현 순서 — 미확정 제안

아래는 조사 당시의 개략 순서다. 이후 상세화한 [M0–M6 마일스톤](ARCHITECTURE_MILESTONES.md)이 최신 기준이다.

| 순서 | 산출물 | 완료 기준 |
|---|---|---|
| 1 | EVM ↔ EVM, LayerZero V2 읽기 전용 검사기 | 직접 OFT와 수동 어댑터 입력으로 경로 검사. 실패·미확인 사유 표시 |
| 2 | 주소 탐색과 후보 선택 | 공식 메타데이터 연동, 여러 어댑터 구분, 미등록 주소 입력 유지 |
| 3 | 견적·파라미터 생성 | 정확한 단위·옵션·value 계산, 개별 필드·tuple·calldata 내보내기 |
| 4 | 지갑 연결과 시뮬레이션 | 실제 송신자 기준 준비 상태 확인, 승인 필요 상태 분리, 서명 전 재검증 |
| 5 | 사용자 실행과 상태 추적 | 승인 후 재검사, 지갑에서 서명, 목적지 도착 단계 표시 |

Stargate 자체 Pool 경로 지원은 초기 범위에서 제외한다. 추후 별도 필요가 생기면 전용 검사기와 계산 분기가 필요하며 일반 OFT라고 처리하지 않는다.

후속 확장 후보는 비EVM 목적지, 이전 OFT 버전, 네이티브 자산·대체 수수료 모델, 커스텀 어댑터, 활동 기반 인덱서다. Bus, compose, swap, 무인 전송은 초기 범위로 확정하지 않았다.

구현 구조 제안:

```text
chain registry → deployment discovery → implementation detection
               → route checks → amount/options/quote → source simulation
               → parameter export / wallet request → message tracking
```

공통 IOFT 엔진과 Stargate 등 구현별 처리기를 분리한다. 직접 입력·조회·검증 기능은 등록 토큰 API가 중단되어도 사용 가능하게 설계한다. 비공개 RPC 키를 브라우저 번들·공유 URL·로그에 포함하지 않는다.

## 12. 구현 시 보관할 데이터

| 객체 | 핵심 정보 |
|---|---|
| Chain | 환경, VM, chainId, EID, Endpoint, RPC 목록, 네이티브 통화·단위, 탐색기 |
| DeploymentCandidate | 체인, 토큰·브릿지 주소, 구현 종류, 버전, 발견 출처, 공식성 근거 |
| RouteCheck | 출발·도착 후보, 양쪽 peer, effective 메시지 설정, 항목별 결과 |
| TransferDraft | 송신자, 수신자, 환불 주소, 문자열 수량, 슬리피지, 옵션 |
| Quote | 실제 차감·수령량, 한도·수수료, nativeFee, value, 시각·블록·입력 해시 |
| Simulation | 대상 체인·블록, account, 인자·value, 성공/revert, 가정한 상태 여부 |
| MessageRecord | 출발 tx, GUID, 양쪽 EID와 OApp, 단계별 상태, 목적지 tx |

큰 정수는 JSON에서 10진 문자열로 저장한다. 출발·도착 RPC의 관찰 블록과 시각은 각각 기록한다. 두 체인에 걸친 단일 원자적 스냅샷을 얻었다고 표시하지 않는다.

## 13. 구현 단계에서 확인할 주요 사례

아래는 검증 계획이며, 이번 조사에서 실행한 테스트 목록이 아니다.

- 프론트·메타데이터 미등록이지만 수동 입력한 표준 OFT 경로가 정상인 경우.
- 일반 ERC-20, 별도 어댑터, 같은 토큰의 복수 어댑터를 구분하는 경우.
- 출발 peer만 설정되고 목적지 peer가 틀렸거나 코드가 없는 경우.
- API에 지원으로 표시되지만 현재 메시지 설정이 차단된 경우.
- 승인 불필요 OFT에서 allowance=0인 경우와, 승인 필요 어댑터의 allowance 부족.
- 6·18 등 서로 다른 decimals, dust, 전송 후 0이 되는 소액, 정수 상한.
- 견적상 수령량이 입력량보다 적고 슬리피지 0인 경우.
- enforced 옵션이 없거나, 존재하지만 필요한 가스가 없거나, caller 옵션과 중복되는 경우.
- 향후 Stargate 지원을 별도 추가할 때: Taxi의 옵션 처리와 네이티브 원금 포함 value 계산. 초기 버전 검증 범위에는 포함하지 않는다.
- RPC 체인 불일치, rate limit, 조회 실패, 한쪽 체인만 접근 가능한 경우.
- 견적 후 입력 변경, 승인 대기 중 견적 만료, 실행 직전 한도 변경.
- 미지원 커스텀 ABI, proxy 변경, 출발 시뮬레이션 성공 뒤 목적지 실행 실패.
- 한 tx에 여러 메시지, 인덱싱 지연, 새 Scan 상태값, 체인별 탐색기 링크.

단위·옵션 인코딩 검사는 오프라인에서, 상태 변화와 실패 사례는 로컬 포크·테스트넷에서 우선 검증한다. 실제 자산을 움직여야만 검증할 수 있는 것으로 설계하지 않는다.

대시보드가 준비되면 사용자가 직접 수행할 소액 시험 전송으로 실제 수령을 확인한다. 0개 전송을 앞단의 필수 조건으로 넣지 않는다. 시험 수량의 토큰 가치와 네트워크 수수료는 구분해 표시한다.

## 14. 후속 결정 상태

1. 지갑 연결·전송까지 목표로 확정. Rabby 브라우저 확장을 사용한다.
2. 초기 네트워크는 BSC ↔ Ethereum으로 확정. 실제 참고 예시는 DOS로 확보했다.
3. 사용자 사용 목적에 따라 일반 V2 OFT·OFTAdapter를 먼저 지원하고 Stargate 자체 Pool 경로는 초기 범위에서 제외한다.
4. CA 자동 탐색, 미발견 명시, 주소 직접 입력·성공 거래 해시로 보완하는 흐름을 반영했다. 상시 활동 인덱서 구축은 초기 범위에 포함하지 않는다.
5. 무료·공개 RPC 기본 사용, RPC 오류 명시, 장애 시 사용자의 체인별 RPC 직접 입력으로 확정했다.
6. 슬리피지·승인·견적 갱신 등의 구현 기본값과 실제 컨트랙트에서 확인할 기술적 불확실성은 아키텍처 문서 7·9절에 정리했다. 현재 추가 필수 사용자 결정은 없다.

이 문서는 조사·설계 단계의 기술 메모다. 이후 실제 구현과 검증 결과는 [README](../README.md)를 참고한다. 모든 OFT를 자동 발견하거나 모든 경로의 수령을 보장하는 기능을 구현·검증한 상태는 아니다.

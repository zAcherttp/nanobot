# THESIS_SCOPE.md

## Tên đề tài

**Đề tài:** `Tích hợp LLM để phát triển trợ lý ảo giúp quản lý lịch trình và công việc hàng ngày`

Tài liệu này xác định phạm vi học thuật và phạm vi triển khai hiện tại của `miniclaw` trong bối cảnh đề tài trên. Trong phạm vi hiện tại, `miniclaw` được xem là hiện vật triển khai chính dùng để kiểm chứng từng phần giả thuyết nghiên cứu, thay vì là một sản phẩm hoàn chỉnh đã hiện thực đầy đủ mọi tuyên bố của luận văn.

Theo định hướng khái niệm trong `docs/assistant/framework.md`, hệ thống này không được hiểu đơn thuần như một công cụ sắp lịch thông minh hơn. Mục tiêu của nó là một trợ lý ảo dựa trên LLM có khả năng hỗ trợ quản lý lịch trình và công việc hằng ngày thông qua bộ nhớ, ngữ cảnh, quyền tự chủ của người dùng, và khả năng thích nghi hành vi theo thời gian.

## Mục tiêu nghiên cứu

Mục tiêu tổng quát của đề tài là khảo sát khả năng tích hợp LLM vào một trợ lý ảo phục vụ quản lý lịch trình và công việc hằng ngày theo hướng cá nhân hóa. Trong cách hiểu này, trợ lý không chỉ phản hồi câu hỏi hay thực hiện thao tác lịch đơn lẻ, mà còn phải duy trì được ngữ cảnh làm việc, ghi nhớ thông tin người dùng, hỗ trợ các tác vụ nhiều bước, và tương tác theo cơ chế tôn trọng quyền quyết định của người dùng.

Cụ thể hơn, hướng nghiên cứu mà `miniclaw` đang phục vụ bao gồm:

- sử dụng LLM làm lõi suy luận cho trợ lý ảo;
- hỗ trợ quản lý lịch trình, tác vụ, và điều phối công việc hằng ngày;
- tạo nền tảng cho cá nhân hóa thông qua các lớp trạng thái như lịch sử hội thoại, `USER.md`, `TASKS.md`, và các kỹ năng (`skills`);
- ưu tiên mô hình tương tác có xác nhận và đồng thuận trước khi thực hiện các hành động có tác động thực tế, đặc biệt là trên lịch.

## Phạm vi triển khai hiện tại của `miniclaw`

Trong trạng thái hiện tại, `miniclaw` đã hiện thực một lát cắt triển khai đủ rõ để mô tả như một nguyên mẫu nghiên cứu có cấu trúc. Các thành phần đã có thể xem là đã triển khai gồm:

- **Kênh tương tác:** hệ thống hiện hỗ trợ hai kênh chính là CLI và Telegram. SSE đã được loại bỏ để tập trung vào một bề mặt vận hành hẹp và ổn định hơn.
- **API runtime:** máy chủ `Hono` chỉ còn giữ các endpoint mỏng cho `health check` và `generic message ingress`, phục vụ vai trò cổng tiếp nhận thông điệp thay vì giao diện tương tác web đầy đủ.
- **Quản lý công việc nhiều bước:** `TASKS.md` đã được dùng như một bề mặt trạng thái bền vững cho các `active jobs` và `archived jobs`, đi kèm với `TaskService` và bộ `task tools` có cấu trúc thay cho chỉnh sửa Markdown tự do.
- **Quản lý hồ sơ người dùng:** `USER.md` đã có phần managed profile phục vụ onboarding và lưu các preference cơ bản như timezone, ngôn ngữ, phong cách giao tiếp, mức độ kỹ thuật, và thiết lập lịch mặc định.
- **Onboarding dưới dạng tác vụ:** việc hỏi thông tin ban đầu không còn là một chế độ riêng, mà được mô hình hóa như một job tự động được chèn vào hệ thống tác vụ khi hồ sơ người dùng còn thiếu.
- **Skill runtime thực:** agent hiện có các công cụ `list_skills`, `load_skill`, và `get_skill_info`, cho phép nạp skill theo nhu cầu ở từng lượt thay vì giả định skill luôn hiện diện trong prompt.
- **Tích hợp Google Calendar theo hướng provider-specific:** thay vì một generalized calendar tool, `miniclaw` hiện đi theo bộ `gws-*` skills để hỗ trợ hành vi liên quan đến Google Calendar.
- **Persistence và compaction:** hội thoại được lưu bền vững, có cơ chế compaction, và đã được kiểm thử ở mức runtime thay vì chỉ ở mức helper thuần.
- **Độ tin cậy của runtime chính:** các phần cốt lõi như agent loop, persistence, gateway, Telegram flow, task services, và task tools đã có test coverage trực tiếp, giúp giảm rủi ro sai khác giữa mô tả kiến trúc và hành vi thực thi.

Như vậy, ở góc nhìn triển khai, `miniclaw` đã vượt qua mức một bản demo ý tưởng đơn giản. Nó đã có kiến trúc agent, trạng thái bền vững, hệ thống tác vụ, và bề mặt skill/tool thực sự để làm nền cho thảo luận học thuật.

## Những gì `miniclaw` chưa đại diện đầy đủ cho luận văn

Dù đã có nền tảng triển khai tương đối rõ, `miniclaw` hiện vẫn chưa hiện thực đầy đủ các tuyên bố mạnh hơn của khung lý thuyết trong `docs/assistant/framework.md`. Các khoảng trống chính gồm:

- **Chưa có lớp behavioral heuristic extraction đủ mạnh:** `USER.md` hiện chủ yếu vẫn là nơi lưu preference và thông tin được thu thập trực tiếp, chưa phải là nơi chứa các heuristic hành vi được rút ra một cách đáng tin cậy từ dấu vết episodic.
- **Chưa hoàn chỉnh luồng Dream-style semantic consolidation:** luận văn định vị một cơ chế tương tự memory consolidation, nhưng trong `miniclaw` hiện chưa có một pipeline hoàn thiện và được kiểm chứng để biến lịch sử tương tác thành tri thức hành vi bền vững trong `USER.md`.
- **Prospective memory chưa được thể hiện trọn vẹn:** hệ thống đã có tách biệt tương đối giữa `GOALS.md` và `TASKS.md`, nhưng chưa đủ để khẳng định đã hiện thực đầy đủ lớp prospective memory theo nghĩa mạnh của khung lý thuyết.
- **Chưa có evaluation harness cho các câu hỏi nghiên cứu chính:** hiện chưa có bộ đánh giá chặt chẽ cho chất lượng trích xuất affect signals, ngưỡng chuyển từ quan sát yếu sang heuristic mạnh, hay cảm nhận autonomy của người dùng theo thời gian.
- **Chưa có đường thực thi cho Lark:** `lark` hiện mới chỉ có thể tồn tại như một preference được lưu, chưa có bộ skills hay action path tương ứng.
- **Chưa có vòng lặp end-to-end được kiểm chứng đầy đủ cho proposal, consent, execution, và hậu kiểm:** đây là phần rất quan trọng nếu muốn bảo vệ luận điểm rằng trợ lý không chỉ thao tác lịch mà còn hỗ trợ ra quyết định theo hướng bảo toàn quyền tự chủ của người dùng.

Những khoảng trống trên có nghĩa là `miniclaw` hiện mới hiện thực một phần của kiến trúc luận văn, chứ chưa đủ để đại diện hoàn chỉnh cho toàn bộ mô hình nhận thức và hành vi mà luận văn đặt ra.

## Phạm vi loại trừ

Để tránh overclaim trong báo cáo, cần ghi rõ các giới hạn sau:

- Không mô tả `miniclaw` như một **autonomous scheduler** đã hoàn thiện.
- Không tuyên bố rằng hệ thống đã hiện thực trọn vẹn toàn bộ kiến trúc nhận thức nhiều lớp được nêu trong khung lý thuyết.
- Không tuyên bố khả năng tương đương giữa nhiều calendar provider; ở thời điểm hiện tại chỉ có hướng `gws-*` là có giá trị triển khai thực tế.
- Không xem onboarding preferences trong `USER.md` là tương đương với behavioral modeling được học từ dữ liệu tương tác thực.
- Không xem `TASKS.md` hiện tại là bằng chứng đủ mạnh cho prospective memory theo nghĩa học thuật đầy đủ.

Phần loại trừ này đặc biệt quan trọng vì nó xác định ranh giới giữa những gì đã được xây dựng và những gì mới dừng ở mức giả thuyết hoặc định hướng mở rộng.

## Giá trị học thuật hiện tại

Mặc dù chưa hoàn chỉnh, `miniclaw` đã có một số giá trị học thuật đủ rõ để xuất hiện trong luận văn như phần hiện thực hóa nguyên mẫu:

- Nó cung cấp một **LLM agent architecture** cụ thể cho bài toán tương tác với lịch trình và công việc hằng ngày.
- Nó đã có các **bề mặt trạng thái tường minh** như `USER.md`, `TASKS.md`, và thread history, cho phép phân tách tương đối rõ giữa hồ sơ người dùng, công việc đang theo dõi, và lịch sử hội thoại.
- Nó đã thể hiện một **mô hình hành động có cân nhắc quyền tự chủ**, khi thao tác lịch được định hướng qua skills và xác nhận thay vì mặc định tự động hóa toàn phần.
- Nó tạo ra một **implementation slice hẹp nhưng kiểm chứng được**, phù hợp để làm nền cho các bước đánh giá tiếp theo thay vì mở rộng quá sớm sang nhiều kênh và nhiều provider.

Ở góc nhìn luận văn, điểm mạnh hiện tại của `miniclaw` không nằm ở việc đã giải quyết xong toàn bộ bài toán, mà ở việc nó đã định hình được một nguyên mẫu có ranh giới rõ, có cấu trúc trạng thái rõ, và có thể tiếp tục được đánh giá một cách có phương pháp.

## Các bước tiếp theo trước khi viết luận văn hoàn chỉnh

Trước khi có thể viết phần mô tả luận văn theo hướng đủ chặt chẽ và thuyết phục, các bước tiếp theo nên được ưu tiên theo thứ tự sau:

1. Hiện thực cơ chế trích xuất behavioral signals từ lịch sử tương tác và nâng chúng thành confidence-scored heuristics trong `USER.md`.
2. Xây dựng logging rõ ràng cho luồng proposal, confirmation, execution, và hậu quả của các hành động liên quan đến lịch.
3. Thiết kế một kịch bản end-to-end hoàn chỉnh để đánh giá nguyên mẫu, ví dụ từ thu thập ngữ cảnh, đề xuất sắp xếp lại lịch, xác nhận, đến cập nhật lịch và phản hồi sau đó.
4. Xây dựng cách đo lường cảm nhận autonomy, usefulness, hoặc mức độ phù hợp của các đề xuất để liên hệ trực tiếp với câu hỏi nghiên cứu.
5. Ghi nhận minh bạch các hạn chế còn lại và đóng khung chúng thành future work thay vì để lẫn vào phần đã triển khai.

## Tuyên bố phạm vi

`miniclaw` nên được xem là nguyên mẫu triển khai dùng để khảo sát giả thuyết của đề tài `Tích hợp LLM để phát triển trợ lý ảo giúp quản lý lịch trình và công việc hàng ngày`. Nó đã hiện thực một phần đáng kể của kiến trúc cần thiết cho trợ lý, đặc biệt ở các lớp agent runtime, trạng thái người dùng, quản lý công việc nhiều bước, và skill-driven interaction với Google Calendar.

Tuy nhiên, `miniclaw` hiện mới chỉ **hiện thực từng phần** của kiến trúc luận văn. Vì vậy, trong báo cáo chính thức cần phân biệt rõ:

- cơ chế nào đã có trong code và đã được kiểm chứng;
- cơ chế nào mới ở mức triển khai một phần;
- cơ chế nào vẫn thuộc phạm vi mở rộng hoặc đánh giá trong tương lai.

Chỉ với sự phân tách đó, `miniclaw` mới có thể được trình bày đúng vai trò: không phải một hệ thống hoàn thiện, mà là một prototype có cơ sở kiến trúc và đủ độ chín để phục vụ phân tích học thuật nghiêm túc.

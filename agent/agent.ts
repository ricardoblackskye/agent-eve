import { defineAgent } from "eve";
import { resolveChatModel } from "./chat-model";

export default defineAgent({
  model: resolveChatModel(),
  modelContextWindowTokens: 1_048_576,
});

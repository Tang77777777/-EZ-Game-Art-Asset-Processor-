/** 素材图片 URL；size 仅用于列表缩略图，详情/编辑不传 size。 */
export const materialImageUrl = (
  id: string,
  v?: number,
  type: "raw" | "processed" = "processed",
  size?: number,
  strict = false,
) =>
  `/api/materials/${id}/image.png?type=${type}${v ? `&v=${v}` : ""}${size ? `&size=${size}` : ""}${strict ? "&strict=1" : ""}`;

/** 素材文件 URL（视频勿用 .png 后缀，避免部分浏览器误判） */
export const materialFileUrl = (id: string, v?: number, type: "raw" | "processed" = "raw") =>
  `/api/materials/${id}/image?type=${type}${v ? `&v=${v}` : ""}`;

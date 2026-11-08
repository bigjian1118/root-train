# -*- coding: utf-8 -*-
"""素材文本解析与 docx 生成（纯标准库，零新增依赖）。

docx/pptx 本质是 zip+OOXML：
  - docx 正文在 word/document.xml，按 </w:p> 还原段落、提取 <w:t> 文本；
  - pptx 每页在 ppt/slides/slideN.xml，提取 <a:t> 文本；
  - pdf 无轻量解析手段，降级为「标题+简介」入索引（不阻断生成，只影响召回粒度）。

生成产物写回 rag_chunk（source_type='material'），与文章共用 BGE-M3 + pgvector 检索链路。
"""
import io
import re
import zipfile

from sqlalchemy import select

from ..extensions import db
from ..models import ActivityMaterial
from . import rag_service

_XML_TAG_RE = re.compile(r"<[^>]+>")
_DOCX_PARA_SPLIT_RE = re.compile(r"</w:p>")
_DOCX_TEXT_RE = re.compile(r"<w:t[^>]*>(.*?)</w:t>", re.S)
_PPTX_TEXT_RE = re.compile(r"<a:t>(.*?)</a:t>", re.S)
_PPTX_SLIDE_RE = re.compile(r"^ppt/slides/slide(\d+)\.xml$")
_WS_RE = re.compile(r"[ \t\u00a0]+")

_MIN_USEFUL_CHARS = 20  # 解析出的正文过短（纯图片课件）时回退标题+简介


def _unescape_xml(text: str) -> str:
    import html as html_module

    return html_module.unescape(text)


def extract_docx_text(blob: bytes) -> str:
    """docx -> 段落文本；解析失败返回空串（上层降级）。"""
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            xml = archive.read("word/document.xml").decode("utf-8", errors="ignore")
    except Exception:
        return ""
    paragraphs = []
    for block in _DOCX_PARA_SPLIT_RE.split(xml):
        runs = _DOCX_TEXT_RE.findall(block)
        line = _WS_RE.sub(" ", _unescape_xml("".join(runs))).strip()
        if line:
            paragraphs.append(line)
    return "\n".join(paragraphs)


def extract_pptx_text(blob: bytes) -> str:
    """pptx -> 按页提取文本，页间空行分隔。"""
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            slides = [
                (int(match.group(1)), name)
                for name in archive.namelist()
                if (match := _PPTX_SLIDE_RE.match(name))
            ]
    except Exception:
        return ""
    lines = []
    for _, name in sorted(slides):
        try:
            xml = archive.read(name).decode("utf-8", errors="ignore")
        except Exception:
            continue
        texts = [_WS_RE.sub(" ", _unescape_xml(t)).strip() for t in _PPTX_TEXT_RE.findall(xml)]
        page = "\n".join(t for t in texts if t)
        if page:
            lines.append(page)
    return "\n\n".join(lines)


def material_plain_text(material: ActivityMaterial) -> str:
    """素材索引文本：标题 + 简介 + 文件正文（pdf/失败时仅前两者）。"""
    header = "\n".join(part for part in (material.title, material.brief) if part)
    ext = (material.file_name or "").lower().rsplit(".", 1)[-1]
    body = ""
    try:
        blob = bytes(material.file_blob) if material.file_blob else b""
    except Exception:
        blob = b""
    if blob:
        if ext == "docx":
            body = extract_docx_text(blob)
        elif ext == "pptx":
            body = extract_pptx_text(blob)
    if len(body) < _MIN_USEFUL_CHARS:
        body = ""
    return "\n".join(part for part in (header, body) if part)


def index_material(material_id: str) -> int:
    """重建单个素材的向量切片；素材不存在或解析为空返回 0。"""
    material = db.session.get(ActivityMaterial, material_id)
    if material is None:
        return 0
    return rag_service.index_document(
        "material", material.material_id, material.title, material_plain_text(material)
    )


def reindex_all_materials() -> int:
    """存量素材全量补索引（幂等：已有切片的素材跳过）。"""
    from ..models import RagChunk

    indexed_ids = set(db.session.execute(
        select(RagChunk.source_id).where(RagChunk.source_type == "material")
    ).scalars().all())
    total = 0
    for material in db.session.scalars(select(ActivityMaterial)).all():
        if material.material_id in indexed_ids:
            continue
        total += index_material(material.material_id)
    return total


# ==================== 产物 docx 生成（标准库最小 OOXML） ====================

_DOCX_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"""

_DOCX_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

_DOCX_DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""

_DOCX_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
</w:styles>"""


def _xml_escape(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def markdown_to_docx(markdown_text: str) -> bytes:
    """Markdown -> docx 字节：# 标题映射 Heading 样式，普通段落保留。"""
    paragraphs = []
    for raw_line in (markdown_text or "").splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            continue
        heading_style = None
        if line.startswith("### "):
            heading_style, line = "Heading3", line[4:]
        elif line.startswith("## "):
            heading_style, line = "Heading2", line[3:]
        elif line.startswith("# "):
            heading_style, line = "Heading1", line[2:]
        # 去掉行内加粗/列表符号，保留纯文本（docx 场景足够）
        line = re.sub(r"^[-*·]\s*", "", line)
        line = line.replace("**", "")
        pPr = f'<w:pPr><w:pStyle w:val="{heading_style}"/></w:pPr>' if heading_style else ""
        paragraphs.append(
            f'<w:p>{pPr}<w:r><w:t xml:space="preserve">{_xml_escape(line)}</w:t></w:r></w:p>'
        )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f'<w:body>{"".join(paragraphs)}<w:sectPr/></w:body></w:document>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", _DOCX_CONTENT_TYPES)
        archive.writestr("_rels/.rels", _DOCX_RELS)
        archive.writestr("word/_rels/document.xml.rels", _DOCX_DOC_RELS)
        archive.writestr("word/document.xml", document)
        archive.writestr("word/styles.xml", _DOCX_STYLES)
    return buffer.getvalue()

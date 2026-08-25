import { showToast } from "../components/toast.js";

const EXCEL_CONFIG = {
  HEADER_BG_COLOR: 'E0E0E0',
  HEADER_TEXT_COLOR: '000000',
  BORDER_COLOR: '000000',
  BORDER_STYLE: 'thin',
  MIN_COLUMN_WIDTH: 10,
  COLUMN_WIDTH_PADDING: 2,
  MAX_SHEET_NAME_LENGTH: 30,
  SKIP_FIRST_ROW: true,
  SKIP_FIRST_COLUMN: true,
  LOGO_SPACE_ROWS: 6  
};


class ExcelGenerator {
  constructor(config = EXCEL_CONFIG) {
    this.config = { ...EXCEL_CONFIG, ...config };
    this.workbook = null;
    this.combinedData = [];
    this.headerRows = [];
    this.separatorRows = [];
  }


  async generate(containerId = '#print-template-container') {
    try {
      const metadata = this._getDocumentMetadata();
      const tables = this._getTablesFromContainer(containerId);
      const logoData = await this._extractLogo(containerId);

      this._extractDataFromTables(tables);
      this._addEmptyRowAndColumn();
      this._adjustIndicesForOffset();

      const worksheet = this._createWorksheet();
      this._applyHeaderStyles(worksheet);
      this._applyBorderStyles(worksheet);
      this._applyColumnWidths(worksheet);
      await this._addLogoToWorksheet(worksheet, logoData);

      this._saveWorkbook(worksheet, metadata);

      console.log('Excel generated successfully');
    } catch (error) {
      console.error('Error generating Excel:', error);
      showToast('error', 'Błąd podczas generowania pliku Excel');
    }
  }


  _getDocumentMetadata() {
    const comment = document.getElementById('comment');
    const commision = document.getElementById('commission-name') ||
      document.getElementById('commission-name-mobile');

    if (!comment || !commision) {
      throw new Error('Missing required document metadata elements');
    }

    return {
      id: comment.dataset.id,
      name: commision.dataset.name
    };
  }


  _getTablesFromContainer(containerId) {
    const tables = document.querySelectorAll(`${containerId} table`);

    if (tables.length === 0) {
      throw new Error(`No tables found in container: ${containerId}`);
    }

    return tables;
  }


  async _extractLogo(containerId) {
    try {
      const container = document.querySelector(containerId);
      let logoUrl = null;
      
      if (container) {
        const logoImg = container.querySelector('img[alt="logo"], .print-logo');
        if (logoImg && logoImg.src) {
          logoUrl = logoImg.src;
          console.log('Found logo in container:', logoUrl);
        }
      }
      
      
      if (!logoUrl) {
        console.log('Logo not found in container, using default /img/logo.png');
        logoUrl = '/img/logo.png';
      }

      
      if (logoUrl.startsWith('data:')) {
        console.log('Logo is already base64');
        return {
          base64: logoUrl.split(',')[1],
          mimeType: logoUrl.match(/data:(.*?);/)?.[1] || 'image/png'
        };
      }

      
      console.log('Converting image to base64:', logoUrl);
      return await this._imageToBase64(logoUrl);
    } catch (error) {
      console.error('Error extracting logo:', error);
      return null;
    }
  }


  async _imageToBase64(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      
      
      if (!url.startsWith('http')) {
        
        console.log('Local image path detected');
      } else {
        img.crossOrigin = 'Anonymous';
      }

      img.onload = () => {
        console.log('Image loaded successfully:', img.width, 'x', img.height);
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        try {
          const dataUrl = canvas.toDataURL('image/png');
          const base64Data = dataUrl.split(',')[1];
          console.log('Image converted to base64, length:', base64Data.length);
          resolve({
            base64: base64Data,
            mimeType: 'image/png',
            width: img.width,
            height: img.height
          });
        } catch (error) {
          console.error('Error converting to base64:', error);
          reject(error);
        }
      };

      img.onerror = (error) => {
        console.error('Failed to load image:', url, error);
        reject(new Error('Failed to load image: ' + url));
      };
      
      console.log('Loading image from:', url);
      img.src = url;
    });
  }


  async _addLogoToWorksheet(worksheet, logoData) {
    if (!logoData || !logoData.base64) {
      console.log('No logo data to add to worksheet');
      return;
    }

    try {
      const range = XLSX.utils.decode_range(worksheet['!ref']);
      const numCols = range.e.c + 1;
      const startCol = this.config.SKIP_FIRST_COLUMN ? 1 : 0;

      
      const logoRow = 1;
      const middleCol = Math.floor(numCols / 2);

      
      const mergeStart = Math.max(startCol, middleCol - 2);
      const mergeEnd = Math.min(numCols - 1, middleCol + 2);

      if (!worksheet['!merges']) {
        worksheet['!merges'] = [];
      }

      worksheet['!merges'].push({
        s: { r: logoRow, c: mergeStart },
        e: { r: logoRow + 3, c: mergeEnd }
      });

      
      if (!worksheet['!rows']) {
        worksheet['!rows'] = [];
      }
      for (let i = 0; i < this.config.LOGO_SPACE_ROWS; i++) {
        worksheet['!rows'][i] = { hpt: 20 };
      }
      worksheet['!rows'][logoRow] = { hpt: 60 };
      worksheet['!rows'][logoRow + 1] = { hpt: 60 };

      
      const cellAddress = XLSX.utils.encode_cell({ r: logoRow, c: middleCol });

      
      if (!worksheet['!images']) {
        worksheet['!images'] = [];
      }

      worksheet['!images'].push({
        '!pos': {
          x: mergeStart,
          y: logoRow,
          w: mergeEnd - mergeStart + 1,
          h: 4
        },
        '!data': logoData.base64,
        '!datatype': 'base64'
      });

      
      if (!worksheet[cellAddress]) {
        worksheet[cellAddress] = { t: 's', v: '' };
      }

      worksheet[cellAddress].s = {
        alignment: {
          horizontal: 'center',
          vertical: 'center'
        }
      };

      
      worksheet[cellAddress].l = {
        Target: `data:image/png;base64,${logoData.base64}`,
        Tooltip: 'Logo'
      };

      console.log('Logo added to worksheet at row', logoRow, 'col', middleCol);
    } catch (error) {
      console.warn('Could not add logo to worksheet:', error);
    }
  }


  _extractDataFromTables(tables) {
    tables.forEach(table => {
      this._processTable(table);
      this._addSeparator();
    });

    this._removeTrailingSeparator();
  }

  _processTable(table) {
    const headers = this._extractHeaders(table);
    this.combinedData.push(headers);
    this.headerRows.push(this.combinedData.length - 1);

    const rows = this._extractRows(table);
    rows.forEach(row => this.combinedData.push(row));
  }

  _extractHeaders(table) {
    return Array.from(table.querySelectorAll('thead th'))
      .map(th => th.innerText.trim());
  }

  _extractRows(table) {
    const tbodyRows = table.querySelectorAll('tbody tr');

    if (tbodyRows.length > 0) {
      return Array.from(tbodyRows).map(tr =>
        Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim())
      );
    }

    const allRows = table.querySelectorAll('tr');
    return Array.from(allRows).slice(1).map(tr =>
      Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim())
    );
  }

  _addSeparator() {
    const lastRow = this.combinedData[this.combinedData.length - 1];
    const separator = Array(lastRow.length).fill('');
    this.combinedData.push(separator);
    this.separatorRows.push(this.combinedData.length - 1);
  }

  _removeTrailingSeparator() {
    const lastRow = this.combinedData[this.combinedData.length - 1];
    if (lastRow && lastRow.every(cell => cell === '')) {
      this.separatorRows.pop();
      this.combinedData.pop();
    }
  }


  _addEmptyRowAndColumn() {
    if (!this.config.SKIP_FIRST_COLUMN && !this.config.SKIP_FIRST_ROW) {
      return;
    }

    if (this.config.SKIP_FIRST_COLUMN) {
      this.combinedData.forEach(row => row.unshift(''));
    }

    if (this.config.SKIP_FIRST_ROW) {
      
      const numCols = this.combinedData[0]?.length || 1;
      for (let i = 0; i < this.config.LOGO_SPACE_ROWS; i++) {
        const emptyRow = Array(numCols).fill('');
        this.combinedData.unshift(emptyRow);
      }
    }
  }


  _adjustIndicesForOffset() {
    const offset = this.config.SKIP_FIRST_ROW ? this.config.LOGO_SPACE_ROWS : 0;

    if (offset > 0) {
      this.headerRows = this.headerRows.map(idx => idx + offset);
      this.separatorRows = this.separatorRows.map(idx => idx + offset);
    }
  }


  _createWorksheet() {
    return XLSX.utils.aoa_to_sheet(this.combinedData);
  }


  _applyHeaderStyles(worksheet) {
    const startCol = this.config.SKIP_FIRST_COLUMN ? 1 : 0;

    this.headerRows.forEach(rowIdx => {
      const row = this.combinedData[rowIdx];

      for (let col = startCol; col < row.length; col++) {
        const cellAddress = XLSX.utils.encode_cell({ r: rowIdx, c: col });

        if (worksheet[cellAddress]) {
          worksheet[cellAddress].s = {
            fill: {
              patternType: "solid",
              fgColor: { rgb: this.config.HEADER_BG_COLOR }
            },
            font: {
              color: { rgb: this.config.HEADER_TEXT_COLOR },
              bold: true
            }
          };
        }
      }
    });
  }


  _applyBorderStyles(worksheet) {
    const range = XLSX.utils.decode_range(worksheet['!ref']);
    const startCol = this.config.SKIP_FIRST_COLUMN ? 1 : 0;

    for (let row = range.s.r; row <= range.e.r; row++) {
      if (this.separatorRows.includes(row)) continue;

      for (let col = startCol; col <= range.e.c; col++) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });

        if (!worksheet[cellAddress]) continue;

        worksheet[cellAddress].s = worksheet[cellAddress].s || {};
        worksheet[cellAddress].s.border = this._createBorderStyle();
      }
    }
  }


  _createBorderStyle() {
    const borderConfig = {
      style: this.config.BORDER_STYLE,
      color: { rgb: this.config.BORDER_COLOR }
    };

    return {
      top: borderConfig,
      bottom: borderConfig,
      left: borderConfig,
      right: borderConfig
    };
  }

  _applyColumnWidths(worksheet) {
    const columnWidths = this._calculateColumnWidths();
    worksheet['!cols'] = columnWidths;
  }


  _calculateColumnWidths() {
    const widths = [];
    const numCols = this.combinedData[0]?.length || 0;

    for (let col = 0; col < numCols; col++) {
      let maxLength = this.config.MIN_COLUMN_WIDTH;

      for (let row = 0; row < this.combinedData.length; row++) {
        const cellValue = this.combinedData[row][col] || '';
        if (cellValue.length > maxLength) {
          maxLength = cellValue.length;
        }
      }

      widths.push({ wch: maxLength + this.config.COLUMN_WIDTH_PADDING });
    }

    return widths;
  }


  _saveWorkbook(worksheet, metadata) {
    this.workbook = XLSX.utils.book_new();

    const sheetName = this._sanitizeSheetName(metadata.name);
    XLSX.utils.book_append_sheet(this.workbook, worksheet, sheetName);

    const fileName = this._generateFileName(metadata);
    XLSX.writeFile(this.workbook, fileName);
  }

  _sanitizeSheetName(name) {
    return name.slice(0, this.config.MAX_SHEET_NAME_LENGTH);
  }

  _generateFileName(metadata) {
    const sanitizedName = this._sanitizeSheetName(metadata.name);
    return `${metadata.id}"${sanitizedName}".xlsx`;
  }

  async fetchOrderData() {
    return fetch(`/order-details/${this.orderId}`)
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then(data => {
        if (data.success) {
          return data.data;
        } else {
          throw new Error('Failed to fetch order data');
        }
      });
  }


  reset() {
    this.workbook = null;
    this.combinedData = [];
    this.headerRows = [];
    this.separatorRows = [];
  }
}

export async function generateExcel() {
  const generator = new ExcelGenerator();
  await generator.generate();
}

export async function generatePdf(isShort = false, lang = null) {
  const comment = document.getElementById('comment');
  const commision = document.getElementById('commission-name') || document.getElementById('commission-name-mobile');



  const orderId = comment.dataset.id;


  try {
    
    let hasPricesAccess = false;
    let printBtns = document.querySelectorAll('[id="print-button"]')
    let shortPrintBtns = document.querySelectorAll('[id="short-print-button"]')

    
    const buttonsToCheck = isShort ? shortPrintBtns : printBtns;
    for (const btn of buttonsToCheck) {
      if (btn.dataset.lock === 'true') {
        hasPricesAccess = true;
        break;
      }
    }
    console.log('Has prices access:', hasPricesAccess, 'isShort:', isShort);

    let downloadUrl = `/orders/orderpdf/${orderId}/${hasPricesAccess ? 'true' : 'false'}/${isShort ? 'true' : 'false'}`;
    // Stan kłódki "Pokaż cenę po rabacie" (order.js revealPriceRows/hidePriceRows)
    // — czysto przeglądarkowy, więc PDF musi go dostać jako parametr requestu,
    // inaczej dla grupy typu `client` zawsze wracałby do stanu "schowane"
    // (services/subPrices.js resolveGroupClientPdfPriceView).
    const params = new URLSearchParams();
    if (window.__clientDiscountPriceVisible) {
      params.set('discountUnlocked', 'true');
    }
    if (lang) {
      params.set('lang', lang);
    }
    const queryString = params.toString();
    if (queryString) {
      downloadUrl += `?${queryString}`;
    }
    console.log('Generating PDF from URL:', downloadUrl);
    const response = await fetch(downloadUrl);
    console.log(response)
    if (!response.ok) {
      
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const errorData = await response.json();
        if (errorData.success === false) {
          showToast('error', errorData.message);
          return;
        }
      }
      throw new Error(`HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const langSuffix = lang ? `_${lang.toUpperCase()}` : '';
    const pdfFileName = `${t('history_order.title')}_${orderId}${langSuffix}`;
    link.download = `${pdfFileName}.pdf`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);

  } catch (error) {
    console.error('Błąd podczas generowania PDF:', error);
    showToast('error', 'Wystąpił błąd podczas generowania PDF');
  }
}